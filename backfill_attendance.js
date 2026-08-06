// 补齐 8月1-5日 打卡明细到 dingtalk_data.json
const https = require('https');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'dingtalk_config.json');
const DATA_FILE = path.join(__dirname, 'dingtalk_data.json');

const ON_DUTY_MAP = {
  'Normal': '正常', 'Late': '迟到', 'SeriousLate': '严重迟到',
  'NotSigned': '缺卡', 'Absenteeism': '缺卡',
  'BusinessTravel': '出差', 'Out': '外出', 'Free': '自由工时'
};
const OFF_DUTY_MAP = {
  'Normal': '正常', 'Early': '早退',
  'NotSigned': '缺卡', 'Absenteeism': '缺卡',
  'BusinessTravel': '出差', 'Out': '外出', 'Free': '自由工时'
};

function toLocalDate(ts) {
  var ms = ts > 10000000000 ? ts : ts * 1000;
  var d = new Date(ms + 8 * 3600000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth()+1).padStart(2,'0') + '-' + String(d.getUTCDate()).padStart(2,'0');
}

function dingRequest(method, host, p, query, body) {
  return new Promise((resolve, reject) => {
    const qs = query ? '?' + Object.entries(query).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&') : '';
    const opts = { hostname: host, path: p + qs, method: method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(JSON.stringify(body));
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(_) { reject(new Error('解析失败: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('超时')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getAccessToken(appKey, appSecret) {
  const res = await dingRequest('GET', 'oapi.dingtalk.com', '/gettoken', { appkey: appKey, appsecret: appSecret });
  if (res.errcode !== 0) throw new Error('获取token失败: ' + res.errmsg);
  return res.access_token;
}

async function main() {
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const token = await getAccessToken(config.appKey, config.appSecret);

  // 获取员工列表
  console.log('[1] 获取员工列表...');
  async function getAllDeptIds(parentId) {
    const res = await dingRequest('POST', 'oapi.dingtalk.com', '/topapi/v2/department/listsub', { access_token: token }, { dept_id: parentId });
    if (res.errcode !== 0) return [parentId];
    const subDepts = res.result || [];
    let ids = [parentId];
    for (const sub of subDepts) {
      const children = await getAllDeptIds(sub.dept_id);
      ids = ids.concat(children);
    }
    return ids;
  }
  const allDeptIds = await getAllDeptIds(config.deptId || 1);
  console.log('  部门: ' + allDeptIds.length + ' 个');

  const nameMap = {}; // userId → {name, userid}
  const seen = {};
  for (const did of allDeptIds) {
    var cursor = 0;
    while (true) {
      const userRes = await dingRequest('POST', 'oapi.dingtalk.com', '/topapi/v2/user/list', { access_token: token }, {
        dept_id: did, cursor: cursor, size: 100, contain_access_limit: false
      });
      if (userRes.errcode !== 0) break;
      const list = userRes.result?.list || [];
      list.forEach(function(u) {
        if (!seen[u.userid]) { seen[u.userid] = true; nameMap[u.userid] = u; }
      });
      if (!userRes.result?.has_more) break;
      cursor = userRes.result?.next_cursor;
      if (!cursor) break;
    }
  }
  const allUsers = Object.values(nameMap);
  console.log('  ✅ ' + allUsers.length + ' 名员工');

  // 日期范围
  const dates = ['2026-08-01','2026-08-02','2026-08-03','2026-08-04','2026-08-05'];
  console.log('[2] 拉取打卡记录: ' + dates[0] + ' ~ ' + dates[dates.length-1]);

  const userIds = allUsers.map(u => u.userid);
  const allRecords = [];

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    console.log('  日期: ' + date);
    for (let j = 0; j < userIds.length; j += 50) {
      const batch = userIds.slice(j, j + 50);
      var offset = 0;
      while (true) {
        const res = await dingRequest('POST', 'oapi.dingtalk.com', '/attendance/list', { access_token: token }, {
          workDateFrom: date + ' 00:00:00',
          workDateTo: date + ' 00:00:00',
          userIdList: batch,
          offset: offset,
          limit: 50
        });
        if (res.errcode !== 0) {
          console.warn('    ⚠️ errcode=' + res.errcode + ': ' + (res.errmsg || ''));
          break;
        }
        const records = res.recordresult || [];
        allRecords.push(...records);
        console.log('    batch ' + (j/50+1) + ': ' + records.length + ' 条');
        if (!res.hasMore) break;
        offset += records.length;
        await sleep(200);
      }
      await sleep(300);
    }
  }
  console.log('  ✅ 共 ' + allRecords.length + ' 条打卡记录');

  // 构建 attendanceRecords + statusByDate
  console.log('[3] 整理数据...');
  const recordsMap = {}; // name → date → {ci, cir, co, cor}
  const statusMap = {};  // name → date → {m, s}

  allRecords.forEach(r => {
    const userId = r.userId;
    const name = r.userName || (nameMap[userId]?.name) || userId;
    var rawDate = r.workDate || r.userCheckTime;
    var date;
    if (typeof rawDate === 'number') date = toLocalDate(rawDate);
    else date = String(rawDate || '').slice(0, 10);

    if (!recordsMap[name]) recordsMap[name] = {};
    var entry = recordsMap[name][date] || {};

    var timeStr = '';
    if (r.userCheckTime) {
      var ts = r.userCheckTime > 10000000000 ? r.userCheckTime : r.userCheckTime * 1000;
      var td = new Date(ts + 8 * 3600000);
      timeStr = String(td.getUTCHours()).padStart(2,'0') + ':' + String(td.getUTCMinutes()).padStart(2,'0');
    }
    if (r.checkType === 'OnDuty') {
      entry.ci = timeStr;
      entry.cir = ON_DUTY_MAP[r.timeResult] || '正常';
    } else if (r.checkType === 'OffDuty') {
      entry.co = timeStr;
      entry.cor = OFF_DUTY_MAP[r.timeResult] || '正常';
    }
    recordsMap[name][date] = entry;

    // 同时更新statusByDate
    if (!statusMap[name]) statusMap[name] = {};
    var se = statusMap[name][date] || {_fromRecords: true};
    if (r.checkType === 'OnDuty') se.ci = ON_DUTY_MAP[r.timeResult] || '正常';
    else if (r.checkType === 'OffDuty') se.co = OFF_DUTY_MAP[r.timeResult] || '正常';
    statusMap[name][date] = se;
  });

  // 从早晚打卡推导主状态
  for (const [name, dateMap] of Object.entries(statusMap)) {
    for (const [date, entry] of Object.entries(dateMap)) {
      if (!entry._fromRecords) continue;
      delete entry._fromRecords;
      if (!entry.ci) entry.ci = '缺卡';
      if (!entry.co) entry.co = '缺卡';
      // deriveStatus
      var ci = entry.ci, co = entry.co;
      if (ci === '缺卡' && co === '缺卡') { entry.m = '旷工'; entry.s = '缺卡'; }
      else if (ci === '缺卡' && co === '正常') { entry.m = '在岗'; entry.s = '上班缺卡'; }
      else if (ci === '正常' && co === '缺卡') { entry.m = '在岗'; entry.s = '下班缺卡'; }
      else if (ci === '缺卡' && co === '早退') { entry.m = '在岗'; entry.s = '上班缺卡+早退'; }
      else if ((ci === '迟到' || ci === '严重迟到') && co === '早退') { entry.m = '在岗'; entry.s = ci + '+早退'; }
      else if (ci === '迟到' || ci === '严重迟到') { entry.m = '在岗'; entry.s = ci; }
      else if (co === '早退') { entry.m = '在岗'; entry.s = '早退'; }
      else if (ci === '出差' || co === '出差') { entry.m = '外勤'; entry.s = '出差'; }
      else if (ci === '外出' || co === '外出') { entry.m = '外勤'; entry.s = '外出'; }
      else if (ci === '自由工时' || co === '自由工时') { entry.m = '在岗'; entry.s = '自由工时'; }
      else { entry.m = '在岗'; entry.s = '正常'; }
    }
  }

  // 加载现有数据并合并
  console.log('[4] 合并到 dingtalk_data.json...');
  const dd = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const existingMap = {};
  (dd.users || []).forEach(u => { existingMap[u.name] = u; });

  var recAdded = 0, statusAdded = 0;
  (dd.users || []).forEach(u => {
    const newRecs = recordsMap[u.name];
    if (newRecs) {
      if (!u.attendanceRecords) u.attendanceRecords = {};
      Object.keys(newRecs).forEach(d => {
        if (!u.attendanceRecords[d]) {
          u.attendanceRecords[d] = newRecs[d];
          recAdded++;
        }
      });
    }
    const newStatus = statusMap[u.name];
    if (newStatus) {
      Object.keys(newStatus).forEach(d => {
        if (!u.statusByDate[d]) {
          u.statusByDate[d] = newStatus[d];
          statusAdded++;
        }
      });
    }
  });

  // 排序
  (dd.users || []).forEach(u => {
    if (u.attendanceRecords) {
      var sorted = {};
      Object.keys(u.attendanceRecords).sort().forEach(d => { sorted[d] = u.attendanceRecords[d]; });
      u.attendanceRecords = sorted;
    }
    if (u.statusByDate) {
      var sorted2 = {};
      Object.keys(u.statusByDate).sort().forEach(d => { sorted2[d] = u.statusByDate[d]; });
      u.statusByDate = sorted2;
    }
  });

  dd.updated = new Date().toISOString();
  fs.writeFileSync(DATA_FILE, JSON.stringify(dd, null, 2), 'utf8');
  console.log('');
  console.log('🎉 补齐完成！新增 ' + recAdded + ' 天打卡明细 + ' + statusAdded + ' 天在岗状态');
  console.log('  日期: ' + dates[0] + ' ~ ' + dates[dates.length-1]);
}

main().catch(function(e) { console.error(e); process.exit(1); });
