const https = require('https');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'dingtalk_config.json');
const DATA_FILE = path.join(__dirname, 'dingtalk_data.json');

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
              const wd = d.workDate;
              const workDate = new Date(wd > 10000000000 ? wd : wd * 1000).toISOString().slice(0, 10);
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
    const res = await dingRequest('POST', 'oapi.dingtalk.com', '/attendance/list', { access_token: token }, {
      workDateFrom: dateFrom + ' 00:00:00',
      workDateTo: dateTo + ' 00:00:00',
      userIdList: batch,
      offset: 0,
      limit: 50
    });
    if (res.errcode !== 0) {
      console.warn('  ⚠️ 考勤查询失败(errcode=' + res.errcode + '): ' + (res.errmsg || ''));
      continue;
    }
    const records = res.recordresult || [];
    results.push(...records);
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

  // 考勤只能拉最近7天（API硬限制）
  const today = new Date();
  const dates = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }

  // 请假OA审批拉最近90天（分段请求避免超限）
  const leaveDateFrom = new Date(today);
  leaveDateFrom.setDate(leaveDateFrom.getDate() - 90);
  const leaveDateFromStr = leaveDateFrom.toISOString().slice(0, 10);
  const leaveDateToStr = dates[dates.length - 1];

  console.log('[4] 获取考勤记录...');
  const userIds = allUsers.map(u => u.userid);
  const attendance = await getAttendance(token, userIds, dates[0], dates[dates.length - 1]);
  console.log('  ✅ 共 ' + attendance.length + ' 条记录');

  // 整理考勤状态
  console.log('[5] 整理考勤数据...');
  const nameMap = {};
  allUsers.forEach(u => { nameMap[u.userid] = u; });

  const statusMap = {};
  attendance.forEach(r => {
    const name = r.userName || (nameMap[r.userId]?.name) || r.userId;
    var rawDate = r.workDate || r.userCheckTime;
    var date;
    if (typeof rawDate === 'number') {
      // 10-digit = seconds, 13-digit = milliseconds. 阈值: > 100亿=毫秒
      if (rawDate > 10000000000) {
        date = new Date(rawDate).toISOString().slice(0, 10);
      } else {
        date = new Date(rawDate * 1000).toISOString().slice(0, 10);
      }
    } else if (/^\d{10}$/.test(String(rawDate))) {
      date = new Date(Number(rawDate) * 1000).toISOString().slice(0, 10);
    } else if (/^\d{13}$/.test(String(rawDate))) {
      date = new Date(Number(rawDate)).toISOString().slice(0, 10);
    } else {
      date = String(rawDate || '').slice(0, 10);
    }
    if (!statusMap[name]) statusMap[name] = {};
    statusMap[name][date] = ATTEND_STATUS_MAP[r.timeResult] || DEFAULT_STATUS;
  });
  console.log('  ✅ 考勤记录覆盖 ' + Object.keys(statusMap).length + ' 人');

  // 用OA请假审批覆盖考勤状态（拉90天，分段请求）
  console.log('[6] 获取OA请假审批（' + leaveDateFromStr + ' ~ ' + leaveDateToStr + '）...');
  const leaveMap = await getLeaveApprovals(token, leaveDateFromStr, leaveDateToStr);
  let leaveOverlayCount = 0;
  for (const [userId, dateMap] of Object.entries(leaveMap)) {
    const name = nameMap[userId]?.name;
    if (!name) continue;
    if (!statusMap[name]) statusMap[name] = {};
    for (const [date, st] of Object.entries(dateMap)) {
      statusMap[name][date] = st;
      leaveOverlayCount++;
    }
  }
  const leavePersonCount = Object.keys(leaveMap).filter(uid => nameMap[uid]).length;
  console.log('  ✅ 请假覆盖 ' + leaveOverlayCount + ' 个日期（' + leavePersonCount + ' 人）');


  const todayStr = today.toISOString().slice(0, 10);

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
      return {
        name: u.name,
        mobile: u.mobile || '',
        deptName: u.dept_name_list || '',
        statusByDate: merged,
        todayStatus: newSBD[todayStr] || DEFAULT_STATUS
      };
    })
  };

  fs.writeFileSync(DATA_FILE, JSON.stringify(output, null, 2), 'utf8');
  console.log('');
  console.log('🎉 同步完成！输出: ' + DATA_FILE);
  console.log('  部门: ' + allDeptIds.length + ' 个, 员工: ' + output.users.length + ' 人, 考勤: ' + attendance.length + ' 条, 请假覆盖: ' + leaveOverlayCount + ' 天');

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
