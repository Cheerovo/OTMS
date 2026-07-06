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

  // 最近7天考勤
  const today = new Date();
  const dates = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }

  console.log('[4] 获取考勤记录...');
  const userIds = allUsers.map(u => u.userid);
  const attendance = await getAttendance(token, userIds, dates[0], dates[dates.length - 1]);
  console.log('  ✅ 共 ' + attendance.length + ' 条记录');

  // 整理
  console.log('[5] 整理输出...');
  const nameMap = {};
  allUsers.forEach(u => { nameMap[u.userid] = u; });

  const statusMap = {};
  attendance.forEach(r => {
    const name = r.userName || (nameMap[r.userId]?.name) || r.userId;
    const date = String(r.workDate || '').slice(0, 10);
    if (!statusMap[name]) statusMap[name] = {};
    statusMap[name][date] = r.timeResult || 'Normal';
  });

  const todayStr = today.toISOString().slice(0, 10);
  const output = {
    updated: new Date().toISOString(),
    users: allUsers.map(u => ({
      name: u.name,
      mobile: u.mobile || '',
      deptName: u.dept_name_list || '',
      statusByDate: statusMap[u.name] || {},
      todayStatus: statusMap[u.name]?.[todayStr] || 'Normal'
    }))
  };

  fs.writeFileSync(DATA_FILE, JSON.stringify(output, null, 2), 'utf8');
  console.log('');
  console.log('🎉 同步完成！输出: ' + DATA_FILE);
  console.log('  部门: ' + allDeptIds.length + ' 个, 员工: ' + output.users.length + ' 人, 考勤: ' + attendance.length + ' 条');

  console.log('');
  console.log('=== 今日在岗状态 ===');
  const labels = { Normal: '✅在岗', Early: '⚠️早退', Late: '⚠️迟到', Absenteeism: '❌旷工', NotSigned: '❓缺卡', Leave: '📝请假', BusinessTravel: '✈️出差', Out: '🚶外出' };
  output.users.forEach(u => {
    const l = labels[u.todayStatus] || '—';
    console.log('  ' + u.name + ': ' + l);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(e => {
  console.error('❌ 同步失败:', e.message);
  process.exit(1);
});
