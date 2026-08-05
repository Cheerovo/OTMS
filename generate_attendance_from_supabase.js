// 从 Supabase 读取 okr_attendance + okr_employees，生成 dingtalk_data.json 的 statusByDate
const https = require('https');
const fs = require('fs');

const SUPABASE_URL = 'jnjsweczmbegmtfpdepi.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpuanN3ZWN6bWJlZ210ZnBkZXBpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMxNjY5MjksImV4cCI6MjA5ODc0MjkyOX0.FSHAZvScCtqz21RTNGmcgGxLm9riFBaNtmDFDsFqp9o';

function supabaseGet(path) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: SUPABASE_URL,
      path: '/rest/v1/' + path,
      method: 'GET',
      headers: {
        'apikey': ANON_KEY,
        'Authorization': 'Bearer ' + ANON_KEY,
        'Accept': 'application/json'
      }
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('解析失败: ' + data.slice(0,200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('超时')); });
    req.end();
  });
}

async function main() {
  console.log('[1] 从 Supabase 获取考勤数据...');
  const attRes = await supabaseGet('team_data?select=version,data&id=eq.6');
  if (!attRes || attRes.length === 0 || !attRes[0].data) {
    console.error('未找到考勤数据(team_data id=6)');
    process.exit(1);
  }
  const attData = attRes[0].data;
  const attendance = attData.okr_attendance;
  if (!attendance) {
    console.error('考勤数据中没有 okr_attendance');
    process.exit(1);
  }
  const dates = Object.keys(attendance).sort();
  console.log('  ✅ 考勤数据: ' + dates.length + ' 天 (' + dates[0] + ' ~ ' + dates[dates.length-1] + ')');

  console.log('[2] 从 Supabase 获取员工花名册...');
  const orgRes = await supabaseGet('team_data?select=version,data&id=eq.4');
  if (!orgRes || orgRes.length === 0 || !orgRes[0].data) {
    console.error('未找到员工数据(team_data id=4)');
    process.exit(1);
  }
  const employees = orgRes[0].data.okr_employees || [];
  console.log('  ✅ 员工: ' + employees.length + ' 人');

  // 建立 id → name 映射
  const idToName = {};
  employees.forEach(e => { if (e.id && e.name) idToName[e.id] = e.name; });

  console.log('[3] 加载 dingtalk_data.json...');
  const DATA_FILE = require('path').join(__dirname, 'dingtalk_data.json');
  let dd = { users: [] };
  if (fs.existsSync(DATA_FILE)) {
    dd = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }
  const nameIndex = {};
  dd.users.forEach((u, i) => { nameIndex[u.name] = i; });

  console.log('[4] 合并考勤数据到 dingtalk_data.json (2026-01-01 ~ 2026-07-31)...');
  let updated = 0;
  let skippedNoName = 0;
  let skippedNoData = 0;

  for (const [date, empMap] of Object.entries(attendance)) {
    if (date > '2026-07-31') continue; // 只处理1-7月
    if (date < '2026-01-01') continue;

    for (const [empId, status] of Object.entries(empMap)) {
      const name = idToName[empId];
      if (!name) { skippedNoName++; continue; }
      if (!status || typeof status !== 'object') { skippedNoData++; continue; }

      let idx = nameIndex[name];
      if (idx === undefined) {
        // 新用户，添加到列表
        dd.users.push({ name: name, mobile: '', deptName: '', statusByDate: {}, todayStatus: { m: '在岗', s: '正常' }, workDays: null, schedule: null, scheduleByDate: null });
        idx = dd.users.length - 1;
        nameIndex[name] = idx;
      }

      if (!dd.users[idx].statusByDate) dd.users[idx].statusByDate = {};
      // 只在没有数据时才写入（保留已有的钉钉打卡数据）
      if (!dd.users[idx].statusByDate[date]) {
        dd.users[idx].statusByDate[date] = status;
        updated++;
      }
    }
  }

  console.log('  ✅ 写入 ' + updated + ' 条考勤状态');
  if (skippedNoName > 0) console.log('  ⚠️ ' + skippedNoName + ' 条因找不到员工姓名跳过');
  if (skippedNoData > 0) console.log('  ⚠️ ' + skippedNoData + ' 条因数据无效跳过');

  // 按日期排序 statusByDate
  dd.users.forEach(u => {
    if (!u.statusByDate) return;
    const sorted = {};
    Object.keys(u.statusByDate).sort().forEach(d => { sorted[d] = u.statusByDate[d]; });
    u.statusByDate = sorted;
  });

  dd.updated = new Date().toISOString();
  fs.writeFileSync(DATA_FILE, JSON.stringify(dd, null, 2), 'utf8');
  console.log('');
  console.log('🎉 写入完成: ' + DATA_FILE);
  console.log('   用户数: ' + dd.users.length + ', 总日期覆盖: ' + new Set(dd.users.flatMap(u => Object.keys(u.statusByDate||{}))).size + ' 天');
}

main().catch(e => { console.error(e); process.exit(1); });
