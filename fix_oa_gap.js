// 一次性补齐 dingtalk_data.json 中因日期过滤丢失的 OA 请假/外出/出差/加班数据
const https = require('https');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'dingtalk_config.json');
const DATA_FILE = path.join(__dirname, 'dingtalk_data.json');

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

// 从 sync_dingtalk.js 复用的 extractDatesFromFields
function extractDatesFromFields(fields) {
  var dates = [];
  var rf = fields.find(function(f){ return f.component_type === 'DDDateRange'; });
  if (rf && rf.ext_value) {
    try { var rv = JSON.parse(rf.ext_value); if (rv.beginDate) dates.push(toLocalDate(rv.beginDate)); } catch(_) {}
  }
  var gf = fields.find(function(f){ return f.component_type === 'DDGooutField'; });
  if (gf && gf.value) {
    try { var gv = JSON.parse(gf.value); if (Array.isArray(gv) && gv[0]) dates.push(String(gv[0]).slice(0,10)); } catch(_) {}
  }
  var df = fields.find(function(f){ return f.component_type === 'DDDateField'; });
  if (df && df.value) {
    var ds = String(df.value).slice(0,10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(ds)) dates.push(ds);
  }
  var bizField = fields.find(function(f){ return f.component_type === 'DDBizSuite'; });
  if (bizField && bizField.value) {
    try {
      var bizChildren = JSON.parse(bizField.value);
      if (Array.isArray(bizChildren)) {
        bizChildren.forEach(function(child) {
          if (child.componentType === 'TableField' && child.value) {
            try {
              var rows = JSON.parse(child.value);
              if (Array.isArray(rows)) {
                rows.forEach(function(row) {
                  if (row.date) dates.push(String(row.date).slice(0,10));
                  else if (row.value && typeof row.value === 'object') {
                    Object.values(row.value).forEach(function(v) {
                      var s = String(v).slice(0,10);
                      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) dates.push(s);
                    });
                  }
                });
              }
            } catch(_) {}
          }
          if (child.componentType === 'DDDateField' && child.value) {
            var ds2 = String(child.value).slice(0,10);
            if (/^\d{4}-\d{2}-\d{2}$/.test(ds2)) dates.push(ds2);
          }
        });
      }
    } catch(_) {}
  }
  return dates;
}

async function main() {
  var config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  var token = await getAccessToken(config.appKey, config.appSecret);

  // 60天前到今天+2天
  var bjNow = new Date(Date.now() + 8 * 3600000);
  var today = toLocalDate(bjNow.getTime());
  var d = new Date(today + 'T00:00:00+08:00');
  d.setDate(d.getDate() - 60);
  var from60 = toLocalDate(d.getTime());
  d = new Date(today + 'T00:00:00+08:00');
  d.setDate(d.getDate() + 2);
  var to2 = toLocalDate(d.getTime());

  console.log('OA 全量修复: ' + from60 + ' ~ ' + to2);

  // 获取员工列表（复用 sync_dingtalk.js 的递归方式）
  console.log('[0] 获取员工列表...');
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

  const employees = [];
  var seen = {};
  for (const did of allDeptIds) {
    var cursor = 0;
    while (true) {
      const userRes = await dingRequest('POST', 'oapi.dingtalk.com', '/topapi/v2/user/list', { access_token: token }, {
        dept_id: did, cursor: cursor, size: 100, contain_access_limit: false
      });
      if (userRes.errcode !== 0) break;
      const list = userRes.result?.list || [];
      list.forEach(function(u) {
        if (!seen[u.userid]) { seen[u.userid] = true; employees.push(u); }
      });
      if (!userRes.result?.has_more) break;
      cursor = userRes.result?.next_cursor || (list.length > 0 ? list.length : undefined);
      if (!cursor) break;
    }
  }
  console.log('  ✅ ' + employees.length + ' 名员工');
  const idToName = {};
  employees.forEach(function(e) { idToName[e.userid] = e.name; });

  // 加载现有数据
  var dd = { users: [] };
  if (fs.existsSync(DATA_FILE)) {
    dd = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }
  var nameIndex = {};
  dd.users.forEach(function(u, i) { nameIndex[u.name] = i; });

  var totalFixed = 0;

  // 通用OA拉取+合并函数
  async function fetchAndMerge(label, processCodes, buildStatusFn) {
    console.log('[' + label + '] 拉取OA审批...');
    const fromDate = new Date(from60 + 'T00:00:00+08:00');
    const toDate = new Date(to2 + 'T23:59:59+08:00');
    var datesFound = 0;
    var peopleFound = 0;

    var chunkStart = new Date(fromDate);
    while (chunkStart < toDate) {
      var chunkEnd = new Date(chunkStart);
      chunkEnd.setDate(chunkEnd.getDate() + 29);
      if (chunkEnd > toDate) chunkEnd = toDate;
      console.log('  时段: ' + chunkStart.toISOString().slice(0,10) + ' ~ ' + chunkEnd.toISOString().slice(0,10));

      for (const code of processCodes) {
        try {
          const idsRes = await dingRequest('POST', 'oapi.dingtalk.com', '/topapi/processinstance/listids', { access_token: token }, {
            process_code: code,
            start_time: chunkStart.getTime(),
            end_time: chunkEnd.getTime(),
            size: 20
          });
          if (idsRes.errcode !== 0) { await sleep(300); continue; }
          const idList = (idsRes.result?.list || []);
          console.log('    ' + code.slice(0,25) + ': ' + idList.length + ' 条');

          for (const id of idList) {
            await sleep(200);
            try {
              const detailRes = await dingRequest('POST', 'oapi.dingtalk.com', '/topapi/processinstance/get', { access_token: token }, { process_instance_id: id });
              if (detailRes.errcode !== 0) continue;
              const inst = detailRes.process_instance;
              if (!inst || inst.status !== 'COMPLETED') continue;

              var name = idToName[inst.originator_userid];
              if (!name) continue;
              var idx = nameIndex[name];
              if (idx === undefined) {
                dd.users.push({ name: name, mobile: '', deptName: '', statusByDate: {}, todayStatus: { m: '在岗', s: '正常' }, workDays: null, schedule: null, scheduleByDate: null });
                idx = dd.users.length - 1;
                nameIndex[name] = idx;
              }
              if (!dd.users[idx].statusByDate) dd.users[idx].statusByDate = {};

              var statuses = buildStatusFn(inst);
              if (typeof statuses === 'object' && !Array.isArray(statuses)) {
                // 返回 { date: {m, s} } 格式
                for (const [dt, st] of Object.entries(statuses)) {
                  dd.users[idx].statusByDate[dt] = { m: st.m, s: st.s, ci: st.m + '_' + st.s, co: st.m + '_' + st.s };
                  datesFound++;
                }
              }
              peopleFound++;
            } catch(_) {}
          }
        } catch(_) {}
        await sleep(300);
      }
      chunkStart = new Date(chunkEnd);
      chunkStart.setDate(chunkStart.getDate() + 1);
    }
    console.log('  ✅ ' + peopleFound + ' 人, ' + datesFound + ' 天');
    return datesFound;
  }

  // 1. 请假
  totalFixed += await fetchAndMerge('请假', [
    'PROC-EF6Y0XWVO2-TGL2OSBZS8OLW2JJ9ZRW2-3K6KC1DI-64',
    'PROC-2E9C6156-7F30-423C-8372-8801D16A3BBF',
    'PROC-379EF1B9-1E62-4E45-8B2B-911FC69F61B1',
  ], function(inst) {
    const result = {};
    const holidayField = (inst.form_component_values || []).find(function(f) { return f.component_type === 'DDHolidayField'; });
    if (!holidayField || !holidayField.ext_value) return result;
    const ext = JSON.parse(holidayField.ext_value);
    var tag = '请假';
    if (ext.extension) {
      try { var extTag = JSON.parse(ext.extension); tag = extTag.tag || '请假'; } catch(_) {}
    }
    (ext.detailList || []).forEach(function(dl) {
      result[toLocalDate(dl.workDate)] = { m: '请假', s: tag };
    });
    return result;
  });

  // 2. 外出
  totalFixed += await fetchAndMerge('外出', [
    'PROC-EF6YCS6WO2-KNL27FSMPPBM60V4TLPH3-06GZC1DI-F1',
  ], function(inst) {
    const result = {};
    var dates = extractDatesFromFields(inst.form_component_values || []);
    dates.forEach(function(d) { result[d] = { m: '外勤', s: '外出' }; });
    return result;
  });

  // 3. 出差
  totalFixed += await fetchAndMerge('出差', [
    'PROC-EF6Y0XWVO2-IGL2LX89MWVYY2JS1RDA2-77UUC1DI-94',
  ], function(inst) {
    const result = {};
    var dates = extractDatesFromFields(inst.form_component_values || []);
    dates.forEach(function(d) { result[d] = { m: '出差', s: '出差' }; });
    return result;
  });

  // 4. 加班
  totalFixed += await fetchAndMerge('加班', [
    'PROC-EF6Y0XWVO2-LGL2JKYWTTC8D8IBNMRS1-DXLQC1DI-96',
  ], function(inst) {
    const result = {};
    var dates = extractDatesFromFields(inst.form_component_values || []);
    dates.forEach(function(d) { result[d] = { m: '加班', s: '加班' }; });
    return result;
  });

  // 排序
  dd.users.forEach(function(u) {
    if (!u.statusByDate) return;
    var sorted = {};
    Object.keys(u.statusByDate).sort().forEach(function(d) { sorted[d] = u.statusByDate[d]; });
    u.statusByDate = sorted;
  });

  dd.updated = new Date().toISOString();
  fs.writeFileSync(DATA_FILE, JSON.stringify(dd, null, 2), 'utf8');
  console.log('');
  console.log('🎉 修复完成！共写入 ' + totalFixed + ' 条 OA 数据');
}

main().catch(function(e) { console.error(e); process.exit(1); });
