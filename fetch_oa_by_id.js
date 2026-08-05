// 拉取指定审批编号的OA审批并合并到 dingtalk_data.json
// 用法: node fetch_oa_by_id.js <审批编号>
// 注意：审批编号可能是 business_id 而非 process_instance_id，脚本会先通过 listids 搜索再获取详情
const https = require('https');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'dingtalk_config.json');
const DATA_FILE = path.join(__dirname, 'dingtalk_data.json');

// 所有请假审批流程编码
const LEAVE_CODES = [
  'PROC-EF6Y0XWVO2-TGL2OSBZS8OLW2JJ9ZRW2-3K6KC1DI-64',  // 请假申请（除病假）
  'PROC-2E9C6156-7F30-423C-8372-8801D16A3BBF',           // 病假申请
  'PROC-379EF1B9-1E62-4E45-8B2B-911FC69F61B1',            // 产假申请
];

function toLocalDate(ts) {
  var ms = ts > 10000000000 ? ts : ts * 1000;
  var d = new Date(ms + 8 * 3600000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth()+1).padStart(2,'0') + '-' + String(d.getUTCDate()).padStart(2,'0');
}

function dingRequest(method, host, p, query, body) {
  return new Promise((resolve, reject) => {
    const qs = query ? '?' + Object.entries(query).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&') : '';
    const opts = {
      hostname: host, path: p + qs, method: method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(JSON.stringify(body));
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (_) { reject(new Error('解析失败: ' + data.slice(0, 200))); }
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

async function findAndFetchApproval(token, businessId) {
  // 审批编号通常格式: YYYYMMDDHHMMSS + 6位数字，如 202606150839000527980
  // 从中提取日期: 2026-06-15
  var dateStr = businessId.slice(0, 8);
  var y = dateStr.slice(0,4), m = dateStr.slice(4,6), d = dateStr.slice(6,8);
  var approxDate = y + '-' + m + '-' + d;
  console.log('  推测审批日期: ' + approxDate);

  // 搜索前后各3天
  var fromDate = new Date(approxDate + 'T00:00:00+08:00');
  fromDate.setDate(fromDate.getDate() - 3);
  var toDate = new Date(approxDate + 'T00:00:00+08:00');
  toDate.setDate(toDate.getDate() + 3);
  var startTime = fromDate.getTime();
  var endTime = toDate.getTime();

  console.log('  搜索范围: ' + fromDate.toISOString().slice(0,10) + ' ~ ' + toDate.toISOString().slice(0,10));

  // 遍历所有请假流程编码搜索
  for (const code of LEAVE_CODES) {
    console.log('  尝试流程: ' + code.slice(0, 20) + '...');
    try {
      const idsRes = await dingRequest('POST', 'oapi.dingtalk.com', '/topapi/processinstance/listids', { access_token: token }, {
        process_code: code,
        start_time: startTime,
        end_time: endTime,
        size: 20
      });

      if (idsRes.errcode !== 0) {
        console.log('    listids失败: ' + idsRes.errmsg);
        await sleep(300);
        continue;
      }

      var idList = (idsRes.result && idsRes.result.list) || [];
      console.log('    找到 ' + idList.length + ' 条审批');

      // 逐个获取详情，匹配审批编号
      for (const pid of idList) {
        await sleep(200);
        const detailRes = await dingRequest('POST', 'oapi.dingtalk.com', '/topapi/processinstance/get', { access_token: token }, {
          process_instance_id: pid
        });

        if (detailRes.errcode !== 0) continue;
        var inst = detailRes.process_instance;
        if (!inst) continue;

        // 检查 business_id 是否匹配
        var bid = inst.business_id || inst.instance_id || inst.process_instance_id || '';
        console.log('    检查: ' + bid + ' (标题: ' + (inst.title||'').slice(0,30) + ')');

        if (String(bid) === String(businessId)) {
          console.log('    ✅ 匹配成功！');
          return inst;
        }

        // 有时候审批编号就是 process_instance_id
        if (String(inst.process_instance_id) === String(businessId)) {
          console.log('    ✅ 匹配成功(process_instance_id)！');
          return inst;
        }
      }
    } catch(e) {
      console.log('    搜索异常: ' + e.message);
    }
    await sleep(300);
  }

  return null;
}

async function main() {
  var config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  var token = await getAccessToken(config.appKey, config.appSecret);

  var businessIds = process.argv.slice(2);
  if (businessIds.length === 0) {
    console.log('用法: node fetch_oa_by_id.js <审批编号1> <审批编号2> ...');
    process.exit(1);
  }

  // 加载现有数据
  var dd = { users: [] };
  if (fs.existsSync(DATA_FILE)) {
    dd = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }
  var nameIndex = {};
  dd.users.forEach(function(u, i) { nameIndex[u.name] = i; });

  var added = 0;

  for (const bid of businessIds) {
    console.log('搜索审批: ' + bid);
    var inst = await findAndFetchApproval(token, bid);

    if (!inst) {
      console.log('  ❌ 未找到匹配的审批记录');
      continue;
    }

    console.log('  发起人: ' + (inst.originator_name || inst.originator_userid));
    console.log('  状态: ' + inst.status);

    // 提取假期数据
    var holidayField = (inst.form_component_values || []).find(function(f) { return f.component_type === 'DDHolidayField'; });
    if (!holidayField || !holidayField.ext_value) {
      console.log('  ⚠️ 无假期字段');
      continue;
    }

    try {
      var ext = JSON.parse(holidayField.ext_value);
      var leaveTag = '请假';
      if (ext.extension) {
        try { var extTag = JSON.parse(ext.extension); leaveTag = extTag.tag || '请假'; } catch(e) {}
      }
      console.log('  类型: ' + leaveTag);

      var detailList = ext.detailList || [];
      console.log('  日期数: ' + detailList.length);

      var userName = inst.originator_name || '';
      // 从标题提取姓名（格式: "王力提交的病假申请"）
      if(!userName && inst.title){
        var m = inst.title.match(/^([\u4e00-\u9fff]{2,4})提交的/);
        if(m) userName = m[1];
      }
      if (!userName) {
        console.log('  ⚠️ 无法确定姓名'); continue;
      }
      console.log('  姓名: ' + userName);

      var idx = nameIndex[userName];
      if (idx === undefined) {
        dd.users.push({ name: userName, mobile: '', deptName: '', statusByDate: {}, todayStatus: { m: '在岗', s: '正常' }, workDays: null, schedule: null, scheduleByDate: null });
        idx = dd.users.length - 1;
        nameIndex[userName] = idx;
      }

      if (!dd.users[idx].statusByDate) dd.users[idx].statusByDate = {};

      for (const dl of detailList) {
        var workDate = toLocalDate(dl.workDate);
        dd.users[idx].statusByDate[workDate] = {
          m: '请假',
          s: leaveTag,
          ci: '请假_' + leaveTag,
          co: '请假_' + leaveTag
        };
        added++;
      }
    } catch(e) {
      console.log('  ⚠️ 解析失败: ' + e.message);
    }
  }

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
  console.log('🎉 写入完成！新增 ' + added + ' 天请假记录');
}

main().catch(function(e) { console.error(e); process.exit(1); });
