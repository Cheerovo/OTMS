const https = require('https');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'dingtalk_config.json');
const DATA_FILE = path.join(__dirname, 'dingtalk_data.json');

// 本地日期格式化（避免 toISOString 的 UTC 偏移问题）
function toLocalDate(ts) {
  // ts: 毫秒(>10000000000) 或 秒(<=10000000000)
  var ms = ts > 10000000000 ? ts : ts * 1000;
  var d = new Date(ms);
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    console.error('请先创建 dingtalk_config.json: {"appKey":"xxx","appSecret":"xxx","deptId":1}');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function dingRequest(method, host, path, query, body) {
  return new Promise((resolve, reject) => {
    const qs = query ? '?' + Object.entries(query).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&') : '';
    const opts = {
      hostname: host, path: path + qs, method: method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(JSON.stringify(body));
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (_) { reject(new Error('响应解析失败')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('超时')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function getAccessToken(appKey, appSecret) {
  console.log('[1] 获取 access_token...');
  const res = await dingRequest('GET', 'oapi.dingtalk.com', '/gettoken', { appkey: appKey, appsecret: appSecret });
  if (res.errcode !== 0) throw new Error('token失败: ' + JSON.stringify(res));
  console.log('  ✅ 成功');
  return res.access_token;
}

// 递归获取所有子部门ID
async function getAllDeptIds(token, parentId) {
  const res = await dingRequest('POST', 'oapi.dingtalk.com', '/topapi/v2/department/listsub', { access_token: token }, {
    dept_id: parentId
  });
  if (res.errcode !== 0) return [parentId];

  const subDepts = res.result || [];
  let allIds = [parentId];

  for (const d of subDepts) {
    const childIds = await getAllDeptIds(token, d.dept_id);
    allIds = allIds.concat(childIds);
  }
  return allIds;
}

// 获取单个部门的员工
async function getDeptUsers(token, deptId) {
  const users = [];
  let cursor = 0;
  while (true) {
    const res = await dingRequest('POST', 'oapi.dingtalk.com', '/topapi/v2/user/list', { access_token: token }, {
      dept_id: deptId, cursor: cursor, size: 100, contain_access_limit: false
    });
    if (res.errcode !== 0) return users;
    const list = res.result?.list || [];
    users.push(...list);
    if (!res.result?.has_more) break;
    cursor = res.result.next_cursor;
  }
  return users;
}

// 按userid去重
function dedupUsers(users) {
  const seen = new Set();
  return users.filter(u => {
    if (seen.has(u.userid)) return false;
    seen.add(u.userid);
    return true;
  });
}

// 考勤状态映射: timeResult → {m:主状态, s:具体状态}
const ATTEND_STATUS_MAP = {
  'Normal': {m:'在岗', s:'正常'},
  'Late': {m:'在岗', s:'迟到'},
  'Early': {m:'在岗', s:'早退'},
  'Free': {m:'在岗', s:'自由工时'},
  'Absenteeism': {m:'旷工', s:'旷工'},
  'NotSigned': {m:'旷工', s:'缺卡'},
  'SeriousLate': {m:'旷工', s:'严重迟到'},
  'BusinessTravel': {m:'外勤', s:'出差'},
  'Out': {m:'外勤', s:'外出'},
};
const DEFAULT_STATUS = {m:'在岗', s:'正常'};

// 获取OA请假审批记录，覆盖考勤数据
// 自动分段请求，每段30天，避免API时间范围超限
async function getLeaveApprovals(token, dateFrom, dateTo) {
  const leaveCodes = [
    'PROC-EF6Y0XWVO2-TGL2OSBZS8OLW2JJ9ZRW2-3K6KC1DI-64',  // 请假申请（除病假）
    'PROC-2E9C6156-7F30-423C-8372-8801D16A3BBF',           // 病假申请
    'PROC-379EF1B9-1E62-4E45-8B2B-911FC69F61B1',            // 产假申请
  ];

  const fromDate = new Date(dateFrom + 'T00:00:00+08:00');
  const toDate = new Date(dateTo + 'T23:59:59+08:00');
  const leaveMap = {};

  // 按30天分段
  const CHUNK_DAYS = 30;
  let chunkStart = new Date(fromDate);

  while (chunkStart < toDate) {
    let chunkEnd = new Date(chunkStart);
    chunkEnd.setDate(chunkEnd.getDate() + CHUNK_DAYS - 1);
    if (chunkEnd > toDate) chunkEnd = toDate;

    const cStart = chunkStart.getTime();
    const cEnd = chunkEnd.getTime();
    const cLabel = chunkStart.toISOString().slice(0,10) + '~' + chunkEnd.toISOString().slice(0,10);
    console.log('    OA分段: ' + cLabel);

    for (const code of leaveCodes) {
      try {
        const idsRes = await dingRequest('POST', 'oapi.dingtalk.com', '/topapi/processinstance/listids', { access_token: token }, {
          process_code: code,
          start_time: cStart,
          end_time: cEnd,
          size: 20
        });
        if (idsRes.errcode !== 0) { await sleep(300); continue; }
        const idList = (idsRes.result?.list || []);

        for (const id of idList) {
          const detailRes = await dingRequest('POST', 'oapi.dingtalk.com', '/topapi/processinstance/get', { access_token: token }, {
            process_instance_id: id
          });
          if (detailRes.errcode !== 0) continue;
          const inst = detailRes.process_instance;
          if (!inst || inst.status !== 'COMPLETED') continue;

          const userId = inst.originator_userid;
          const holidayField = (inst.form_component_values || []).find(f => f.component_type === 'DDHolidayField');
          if (!holidayField || !holidayField.ext_value) continue;

          try {
            const ext = JSON.parse(holidayField.ext_value);
            let leaveTag = '请假';
            if (ext.extension) {
              const extTag = JSON.parse(ext.extension);
              leaveTag = extTag.tag || '请假';
            }
            const detailList = ext.detailList || [];
            for (const d of detailList) {
              const workDate = toLocalDate(d.workDate);
              if (workDate >= dateFrom && workDate <= dateTo) {
                if (!leaveMap[userId]) leaveMap[userId] = {};
                leaveMap[userId][workDate] = {m:'请假', s: leaveTag};
              }
            }
          } catch(_) { /* skip parse errors */ }
          await sleep(200);
        }
      } catch(_) { /* skip chunk errors */ }
      await sleep(300);
    }

    // 下一段
    chunkStart = new Date(chunkEnd);
    chunkStart.setDate(chunkStart.getDate() + 1);
  }

  return leaveMap;
}

// 获取考勤记录
async function getAttendance(token, userIds, dateFrom, dateTo) {
  const results = [];
  for (let i = 0; i < userIds.length; i += 50) {
    const batch = userIds.slice(i, i + 50);
    let offset = 0;
    while (true) {
      const res = await dingRequest('POST', 'oapi.dingtalk.com', '/attendance/list', { access_token: token }, {
        workDateFrom: dateFrom + ' 00:00:00',
        workDateTo: dateTo + ' 00:00:00',
        userIdList: batch,
        offset: offset,
        limit: 50
      });
      if (res.errcode !== 0) {
        console.warn('  ⚠️ 考勤查询失败(errcode=' + res.errcode + '): ' + (res.errmsg || ''));
        break;
      }
      const records = res.recordresult || [];
      results.push(...records);
      if (!res.hasMore) break;
      offset += records.length;
      await sleep(200);
    }
    if (i + 50 < userIds.length) await sleep(300);
  }
  return results;
}

async function main() {
  const config = loadConfig();
  const rootDeptId = config.deptId || 1;

  const token = await getAccessToken(config.appKey, config.appSecret);

  // 递归获取所有部门ID
  console.log('[2] 递归获取所有部门...');
  const allDeptIds = await getAllDeptIds(token, rootDeptId);
  console.log('  ✅ 共 ' + allDeptIds.length + ' 个部门');

  // 从所有部门拉员工并去重
  console.log('[3] 获取所有员工...');
  let allUsers = [];
  for (const did of allDeptIds) {
    const users = await getDeptUsers(token, did);
    allUsers = allUsers.concat(users);
    if (allDeptIds.length > 5) await sleep(200);
  }
  allUsers = dedupUsers(allUsers);
  console.log('  ✅ 共 ' + allUsers.length + ' 名员工（去重后）');

  if (allUsers.length === 0) {
    console.log('没有员工数据，请检查部门ID设置。');
    return;
  }

  // 获取考勤组配置 → 每人工作日
  console.log('[4] 获取考勤组配置...');
  const workDaysByUser = {}; // userId → [dayNum, ...]  (0=Sun, 1=Mon, ..., 6=Sat)
  const groupCache = new Map();
  const userGroupMap = {}; // userId → {group_id, name}
  for (let i = 0; i < allUsers.length; i++) {
    const u = allUsers[i];
    try {
      const res = await dingRequest('POST', 'oapi.dingtalk.com', '/topapi/attendance/getusergroup', { access_token: token }, { userid: u.userid });
      if (res.errcode === 0 && res.result) userGroupMap[u.userid] = res.result;
    } catch(_) {}
    if (i > 0 && i % 20 === 0) {
      console.log('  查询用户考勤组: ' + i + '/' + allUsers.length + '...');
      await sleep(500);
    }
    await sleep(150);
  }
  const uniqueGroups = new Set(Object.values(userGroupMap).map(g => g.group_id).filter(Boolean));
  const usersWithGroup = Object.keys(userGroupMap).length;
  console.log('  ✅ ' + usersWithGroup + ' 人有所属考勤组, 共 ' + uniqueGroups.size + ' 个不同考勤组');

  // 建立 group_id → 某个成员userId 的映射（用作 op_user_id）
  const groupMemberMap = {}; // group_id → userId
  for (const [userId, grp] of Object.entries(userGroupMap)) {
    if (grp.group_id && !groupMemberMap[grp.group_id]) groupMemberMap[grp.group_id] = userId;
  }

  // 查每个考勤组的详情（班次、工作日）
  for (const gid of uniqueGroups) {
    try {
      const opUserId = groupMemberMap[gid] || allUsers[0].userid;
      const res = await dingRequest('POST', 'oapi.dingtalk.com', '/topapi/attendance/group/query', { access_token: token }, { group_id: gid, op_user_id: opUserId });
      if (res.errcode === 0 && res.result) groupCache.set(gid, res.result);
      else console.warn('  ⚠️ 考勤组' + gid + '查询失败: ' + (res.errmsg || res.errcode));
    } catch(_) {}
    await sleep(300);
  }

  // work_day_list 是7元素数组 [Sun, Mon, ..., Sat]，值=0休息，值>0为上班的shift_id
  // 转换为工作日的 dayNum 数组（0=Sun, 1=Mon, ..., 6=Sat）
  function parseWorkDays(wdl) {
    var result = [];
    for (var i = 0; i < wdl.length && i < 7; i++) {
      if (wdl[i] !== 0) result.push(i);
    }
    return result; // e.g., [1,2,3,4,5] = Mon-Fri
  }

  // 从class_setting中提取班次时间字符串（如 9:00-18:00）
  function extractClassTime(cls) {
    try {
      var sections = cls.sections || (cls.class_setting && cls.class_setting.sections) || [];
      if (!sections.length) return null;
      var allTimes = [];
      sections.forEach(function(sec){
        (sec.times || []).forEach(function(t){
          var timeStr = (t.check_time || '').slice(11, 16); // "HH:MM"
          if (timeStr) allTimes.push(timeStr);
        });
      });
      if (allTimes.length >= 2) return allTimes[0] + '-' + allTimes[allTimes.length - 1];
    } catch(_) {}
    return null;
  }

  // 构建 class_id → 时间字符串 的映射
  var classTimeMap = {};
  for (const [gid, cfg] of groupCache) {
    var classes = cfg.classes || [];
    classes.forEach(function(cls){
      var timeStr = extractClassTime(cls);
      if (timeStr) classTimeMap[cls.class_id] = timeStr;
    });
  }

  // 根据考勤组配置推断每人工作日 + 班制时间
  var userSchedule = {}; // userId → "9:00-18:00"
  let fixedCount = 0, turnCount = 0, noneCount = 0;
  for (const [userId, grp] of Object.entries(userGroupMap)) {
    const cfg = groupCache.get(grp.group_id);
    if (!cfg) continue;
    if (cfg.type === 'NONE') { noneCount++; continue; }
    if (cfg.work_day_list && cfg.work_day_list.length === 7) {
      var wdParsed = parseWorkDays(cfg.work_day_list);
      if (wdParsed.length > 0 && wdParsed.length < 7) {
        workDaysByUser[userId] = wdParsed;
        if (cfg.type === 'TURN') turnCount++; else fixedCount++;
      }
      // 取第一个上班日的班次ID，查找对应时间
      for (var wi = 0; wi < cfg.work_day_list.length; wi++) {
        var shiftId = cfg.work_day_list[wi];
        if (shiftId !== 0 && classTimeMap[shiftId]) {
          userSchedule[userId] = classTimeMap[shiftId];
          break;
        }
      }
    }
    // work_day_list 全7天上班 或 无work_day_list → 无休息日过滤
  }
  console.log('  ✅ 工作日配置: FIXED=' + fixedCount + '人 TURN=' + turnCount + '人 NONE=' + noneCount + '人');
  var scheduleCount = Object.keys(userSchedule).length;
  console.log('  ✅ 班制时间: ' + scheduleCount + '人');

  // 考勤只能拉最近7天（API硬限制）
  const today = new Date();
  const dates = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dates.push(toLocalDate(d.getTime()));
  }

  // 请假OA审批拉最近95天（分段请求避免超限，留5天余量防止边界遗漏）
  const leaveDateFrom = new Date(today);
  leaveDateFrom.setDate(leaveDateFrom.getDate() - 95);
  const leaveDateFromStr = toLocalDate(leaveDateFrom.getTime());
  const leaveDateToStr = dates[dates.length - 1];

  console.log('[5] 获取考勤记录...');
  const userIds = allUsers.map(u => u.userid);
  const attendance = await getAttendance(token, userIds, dates[0], dates[dates.length - 1]);
  console.log('  ✅ 共 ' + attendance.length + ' 条记录');

  // 整理考勤状态
  console.log('[6] 整理考勤数据...');
  const nameMap = {};
  allUsers.forEach(u => { nameMap[u.userid] = u; });

  const statusMap = {};
  attendance.forEach(r => {
    const name = r.userName || (nameMap[r.userId]?.name) || r.userId;
    var rawDate = r.workDate || r.userCheckTime;
    var date;
    if (typeof rawDate === 'number') {
      date = toLocalDate(rawDate);
    } else if (/^\d{10}$/.test(String(rawDate))) {
      date = toLocalDate(Number(rawDate));
    } else if (/^\d{13}$/.test(String(rawDate))) {
      date = toLocalDate(Number(rawDate));
    } else {
      date = String(rawDate || '').slice(0, 10);
    }
    if (!statusMap[name]) statusMap[name] = {};
    statusMap[name][date] = ATTEND_STATUS_MAP[r.timeResult] || DEFAULT_STATUS;
  });
  console.log('  ✅ 考勤记录覆盖 ' + Object.keys(statusMap).length + ' 人');

  // 用OA请假审批覆盖考勤状态（拉90天，分段请求），过滤休息日
  console.log('[7] 获取OA请假审批（' + leaveDateFromStr + ' ~ ' + leaveDateToStr + '）...');
  const leaveMap = await getLeaveApprovals(token, leaveDateFromStr, leaveDateToStr);
  let leaveOverlayCount = 0;
  let leaveSkipRest = 0;
  for (const [userId, dateMap] of Object.entries(leaveMap)) {
    const name = nameMap[userId]?.name;
    if (!name) continue;
    if (!statusMap[name]) statusMap[name] = {};
    const wdList = workDaysByUser[userId];
    for (const [date, st] of Object.entries(dateMap)) {
      // 有考勤组工作日配置时，跳过休息日的请假标记
      if (wdList) {
        var dayNum = new Date(date + 'T00:00:00+08:00').getDay(); // 0=Sun
        if (!wdList.includes(dayNum)) { leaveSkipRest++; continue; }
      }
      statusMap[name][date] = st;
      leaveOverlayCount++;
    }
  }
  const leavePersonCount = Object.keys(leaveMap).filter(uid => nameMap[uid]).length;
  console.log('  ✅ 请假覆盖 ' + leaveOverlayCount + ' 个日期（' + leavePersonCount + ' 人）' + (leaveSkipRest > 0 ? '，跳过 ' + leaveSkipRest + ' 个休息日请假' : ''));


  const todayStr = toLocalDate(today.getTime());

  // 加载已有数据，合并累积（而非覆盖）
  let existing = { users: [] };
  if (fs.existsSync(DATA_FILE)) {
    try { existing = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch(_) {}
  }
  const existingMap = {};
  (existing.users || []).forEach(u => { existingMap[u.name] = u; });

  const output = {
    updated: new Date().toISOString(),
    users: allUsers.map(u => {
      const prev = existingMap[u.name];
      const newSBD = statusMap[u.name] || {};
      // 合并历史数据：旧数据打底，新数据覆盖
      const merged = {};
      if (prev && prev.statusByDate) Object.assign(merged, prev.statusByDate);
      Object.assign(merged, newSBD);
      const wd = workDaysByUser[u.userid];
      const schedule = userSchedule[u.userid] || null;
      return {
        name: u.name,
        mobile: u.mobile || '',
        deptName: u.dept_name_list || '',
        statusByDate: merged,
        todayStatus: newSBD[todayStr] || DEFAULT_STATUS,
        workDays: wd || null,  // null=未获取到考勤组配置（全勤，不过滤休息日）
        schedule: schedule     // "9:00-18:00" 或 null
      };
    })
  };

  fs.writeFileSync(DATA_FILE, JSON.stringify(output, null, 2), 'utf8');
  console.log('');
  console.log('🎉 同步完成！输出: ' + DATA_FILE);
  console.log('  部门: ' + allDeptIds.length + ' 个, 员工: ' + output.users.length + ' 人, 考勤: ' + attendance.length + ' 条');

  console.log('');
  console.log('=== 今日在岗状态 ===');
  const mainIcons = { '在岗':'✅', '请假':'📝', '外勤':'🚶', '旷工':'❌' };
  output.users.forEach(u => {
    const ts = u.todayStatus;
    const icon = mainIcons[ts.m] || '—';
    console.log('  ' + u.name + ': ' + icon + ts.m + ' / ' + ts.s);
  });

  // Auto push to GitHub
  try {
    const { execSync } = require('child_process');
    execSync('git add dingtalk_data.json', { cwd: __dirname, stdio: 'pipe', timeout: 10000 });
    execSync('git commit -m "钉钉考勤数据同步 ' + new Date().toISOString().slice(0,10) + '"', { cwd: __dirname, stdio: 'pipe', timeout: 10000 });
    execSync('git push', { cwd: __dirname, stdio: 'pipe', timeout: 30000 });
    console.log(''); console.log('🚀 已推送到 GitHub Pages');
  } catch (e) {
    if (e.stderr && !e.stderr.toString().includes('nothing to commit')) console.warn('  ⚠️ 推送失败: ' + e.stderr.toString().slice(0,200));
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(e => {
  console.error('❌ 同步失败:', e.message);
  process.exit(1);
});
