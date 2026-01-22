require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const Table = require('cli-table3');

console.log("hetzner-billing-auto-shutdown-and-notif ubuntu monitor v0.0.1\n");
console.log('Environment Variables:');
console.log('ServerAPI:', process.env.ServerAPI ? '<found, but not printing>' : '<not found>');
console.log('FEISHU_WEBHOOK_URL:', process.env.FEISHU_WEBHOOK_URL ? '<found, but not printing>' : '<not found>');
console.log('FEISHU_WEBHOOK_SECRET:', process.env.FEISHU_WEBHOOK_SECRET ? '<found, but not printing>' : '<not found>');
console.log('THRESHOLD_PERCENT_NOTIF:', process.env.THRESHOLD_PERCENT_NOTIF || '80 (default)');
console.log('SEND_USAGE_NOTIF_ALWAYS:', process.env.SEND_USAGE_NOTIF_ALWAYS || 'false (default)');
console.log('OBFUSCATE_SERVER_NAMES_FROM_CONSOLE_LOG:', process.env.OBFUSCATE_SERVER_NAMES_FROM_CONSOLE_LOG || 'false (default)');
console.log('-----------------------------------');

// Configuration
const API_TOKEN = process.env.ServerAPI;
const FEISHU_WEBHOOK_URL = process.env.FEISHU_WEBHOOK_URL;
const FEISHU_WEBHOOK_SECRET = process.env.FEISHU_WEBHOOK_SECRET;

const THRESHOLD_PERCENT_NOTIF = parseFloat(process.env.THRESHOLD_PERCENT_NOTIF || '80');
const SEND_USAGE_NOTIF_ALWAYS = process.env.SEND_USAGE_NOTIF_ALWAYS === 'true';
const OBFUSCATE_SERVER_NAMES = process.env.OBFUSCATE_SERVER_NAMES_FROM_CONSOLE_LOG === 'true';

if (!API_TOKEN) {
  console.error('Set ServerAPI first.');
  process.exit(1);
}

function genSign(timestamp, secret) {
  if (!secret) return '';
  const strToSign = `${timestamp}\n${secret}`;
  return crypto.createHmac('sha256', strToSign).digest('base64');
}

async function sendFeishuMessage(text) {
  if (!FEISHU_WEBHOOK_URL || !FEISHU_WEBHOOK_SECRET) {
    console.error('Feishu webhook not configured. Message only printed to console.');
    return { ok: false, status: 0, payload: null, responseText: '' };
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const sign = genSign(timestamp, FEISHU_WEBHOOK_SECRET);
  const response = await fetch(FEISHU_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      timestamp: timestamp.toString(),
      sign,
      msg_type: 'text',
      content: { text },
    }),
  });

  const responseText = await response.text();
  let payload = null;
  if (responseText) {
    try {
      payload = JSON.parse(responseText);
    } catch (err) {
      console.error('Feishu response JSON parse failed:', err);
    }
  }

  if (!response.ok) {
    console.error('Feishu request failed:', response.status, response.statusText);
  }

  if (payload && typeof payload.code !== 'undefined' && payload.code !== 0) {
    console.error('Feishu response error:', payload);
  }

  const ok = response.ok && (!payload || payload.code === 0);
  return { ok, status: response.status, payload, responseText };
}

function obfuscateServerName(name) {
  if (!OBFUSCATE_SERVER_NAMES || !name) return name;
  if (name.length <= 2) return name;

  const firstChar = name.charAt(0);
  const lastChar = name.charAt(name.length - 1);
  const middleLength = name.length - 2;

  return `${firstChar}${'X'.repeat(middleLength)}${lastChar}`;
}

async function fetchServers() {
  try {
    const res = await axios.get('https://api.hetzner.cloud/v1/servers', {
      headers: { Authorization: `Bearer ${API_TOKEN}` }
    });
    return res.data.servers;
  } catch (err) {
    const msg = `:warning: Error fetching Hetzner servers: ${err.message}`;
    console.error(msg);
    await sendFeishuMessage(msg);
    process.exit(1);
  }
}

function bytesToTB(bytes, precision = 4) {
  return (bytes / 1024 ** 4).toFixed(precision);
}

function calculatePercentage(used, total) {
  if (!total) return '0.0000%';
  return ((used / total) * 100).toFixed(4) + '%';
}

async function sendFeishuAlert(serversData, allServersData, sendAlways = false) {
  if (!sendAlways && serversData.length === 0) return;

  let headerText;
  let serversToReport = serversData;

  if (serversData.length > 0) {
    headerText = `⚠️ Server Bandwidth Alert (>${THRESHOLD_PERCENT_NOTIF}%)`;
  } else if (sendAlways) {
    headerText = '🔍 Server Bandwidth Report';
    serversToReport = allServersData;
  }

  const lines = [headerText];
  serversToReport.forEach(server => {
    lines.push(
      `${server.name} (${server.status}): ${server.usagePercentage} used (${server.outgoingTB} TB of ${server.limitTB} TB)`
    );
  });

  const text = lines.join('\n');

  console.log('\n--- Feishu Message ---');
  console.log(text);
  console.log('----------------------\n');

  await sendFeishuMessage(text);
}

(async () => {
  const servers = await fetchServers();

  const table = new Table({
    head: ['Name', 'Status', 'Outgoing (TB)', 'Limit (TB)', 'Usage %', 'Action'],
    style: {
      head: ['cyan'],
      border: ['gray']
    },
    colAligns: ['left', 'left', 'right', 'right', 'right', 'left']
  });

  const highUsageServers = [];
  const allServersData = [];

  for (const s of servers) {
    const outgoingTB = bytesToTB(s.outgoing_traffic || 0);
    const limitTB = bytesToTB(s.included_traffic || 0);
    const usagePercentage = calculatePercentage(
      s.outgoing_traffic || 0,
      s.included_traffic || 0
    );

    const rawPercentage = s.included_traffic ?
      (s.outgoing_traffic || 0) / s.included_traffic : 0;

    let action = 'None';

    const serverData = {
      id: s.id,
      name: s.name,
      status: s.status,
      outgoingTB,
      limitTB,
      usagePercentage,
      rawPercentage
    };

    allServersData.push(serverData);

    if (rawPercentage >= THRESHOLD_PERCENT_NOTIF / 100) {
      highUsageServers.push(serverData);
      action = 'NOTIFY';
    }

    table.push([
      obfuscateServerName(s.name),
      s.status,
      outgoingTB,
      limitTB,
      usagePercentage,
      action
    ]);
  }

  console.log(table.toString());

  await sendFeishuAlert(highUsageServers, allServersData, SEND_USAGE_NOTIF_ALWAYS);
})();
