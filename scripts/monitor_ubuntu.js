require('dotenv').config({ path: '/root/hetzner-billing-auto-shutdown-and-notif/.env' });
const axios = require('axios');
const Table = require('cli-table3');
console.log("Date now", new Date().toISOString());
console.log('Environment Variables:');
console.log('ServerAPI:', process.env.ServerAPI ? '<found, but not printing>' : '<not found>');
console.log('TELEGRAM_BOT:', process.env.TELEGRAM_BOT ? '<found, but not printing>' : '<not found>');
console.log('THRESHOLD_PERCENT_NOTIF:', process.env.THRESHOLD_PERCENT_NOTIF || '80 (default)');
console.log('SEND_USAGE_NOTIF_ALWAYS:', process.env.SEND_USAGE_NOTIF_ALWAYS || 'false (default)');
console.log('OBFUSCATE_SERVER_NAMES_FROM_CONSOLE_LOG:', process.env.OBFUSCATE_SERVER_NAMES_FROM_CONSOLE_LOG || 'false (default)');
console.log('-----------------------------------');

// Configuration
const API_TOKEN = process.env.ServerAPI;
const TELEGRAM_BOT = process.env.TELEGRAM_BOT;

const THRESHOLD_PERCENT_NOTIF = parseFloat(process.env.THRESHOLD_PERCENT_NOTIF || '80');
const SEND_USAGE_NOTIF_ALWAYS = process.env.SEND_USAGE_NOTIF_ALWAYS === 'true';
const OBFUSCATE_SERVER_NAMES = process.env.OBFUSCATE_SERVER_NAMES_FROM_CONSOLE_LOG === 'true';

if (!API_TOKEN) {
  console.error('Set ServerAPI first.');
  process.exit(1);
}

async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT) {
    console.error('Telegram bot not configured. Message only printed to console.');
    return { ok: false, status: 0, payload: null, responseText: '' };
  }

  const encodedText = encodeURIComponent(text);
  const url = `https://api.telegram.org/${TELEGRAM_BOT}/sendMessage?chat_id=6331981948&text=%22${encodedText}%22`;
  const response = await fetch(url);

  const responseText = await response.text();
  let payload = null;
  if (responseText) {
    try {
      payload = JSON.parse(responseText);
    } catch (err) {
      console.error('Telegram response JSON parse failed:', err);
    }
  }

  if (!response.ok) {
    console.error('Telegram request failed:', response.status, response.statusText);
  }

  if (payload && typeof payload.ok !== 'undefined' && payload.ok !== true) {
    console.error('Telegram response error:', payload);
  }

  const ok = response.ok && (!payload || payload.ok === true);
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
    await sendTelegramMessage(msg);
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

async function sendTelegramAlert(serversData, allServersData, sendAlways = false) {
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

  console.log('\n--- Telegram Message ---');
  console.log(text);
  console.log('----------------------\n');

  await sendTelegramMessage(text);
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

  await sendTelegramAlert(highUsageServers, allServersData, SEND_USAGE_NOTIF_ALWAYS);
})();
