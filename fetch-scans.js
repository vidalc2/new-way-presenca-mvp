#!/usr/bin/env node
/**
 * Fetches all scans from May 8th for both JPA and CG projects
 * and exports them as CSV files.
 *
 * Usage: node fetch-scans.js [YYYY-MM-DD]
 * Default date: 2026-05-08
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const TARGET_DATE = process.argv[2] || '2026-05-08';

const PROJECTS = [
  {
    name: 'JPA',
    label: 'New Way JPA (João Pessoa)',
    projectId: '019ca04b-4abf-774b-8240-68bb547dbae5',
    apiKey: 'AZz9dhlrdsOEbbyRIfPiTA.mIZLNFRsW9ai6Nh5Fo9CjxfIRgLzxmN4TU6YT8RVaNU',
  },
  {
    name: 'CG',
    label: 'New Way CG (Campina Grande)',
    projectId: '019c92ae-d49d-77eb-aa27-8cb0b3ea6b7d',
    apiKey: 'AZ0CBsh5f2OFyxGSzJKVRA.Gc_ihXR2SvA8cdH_17JQ_gFC6_tLLx8RDVuqXO53dkE',
  },
];

const API_BASE = 'https://api.prod-brl.trstinc.ca/v1';

function buildAuthHeaders(apiKey) {
  // The key format is "keyId.keySecret" — try multiple conventions
  const [keyId, keySecret] = apiKey.split('.');
  const basicToken = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  const basicTokenFull = Buffer.from(`${apiKey}:`).toString('base64');
  return [
    { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
    { 'X-API-Key': apiKey, 'Accept': 'application/json' },
    { 'Authorization': `Basic ${basicToken}`, 'Accept': 'application/json' },
    { 'Authorization': `Basic ${basicTokenFull}`, 'Accept': 'application/json' },
    { 'Authorization': `ApiKey ${apiKey}`, 'Accept': 'application/json' },
    { 'api-key': apiKey, 'Accept': 'application/json' },
    { 'Authorization': `Token ${apiKey}`, 'Accept': 'application/json' },
  ];
}

function requestWithHeaders(url, headers) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(new Error('Request timed out')); });
    req.end();
  });
}

// Probe one URL trying all auth header variants; returns {res, headers} on first non-401/403 or best guess
async function request(url, apiKey) {
  const variants = buildAuthHeaders(apiKey);
  let lastRes = null;
  for (const headers of variants) {
    try {
      const res = await requestWithHeaders(url, headers);
      lastRes = { res, authHeaders: headers };
      if (res.status !== 401 && res.status !== 403) return lastRes;
    } catch (e) {
      // try next variant
    }
  }
  return lastRes; // return best attempt even if all fail auth
}

async function discoverEndpoints(project) {
  const id = project.projectId;
  const candidates = [
    `/projects/${id}/scans`,
    `/projects/${id}/scan-logs`,
    `/projects/${id}/scan_logs`,
    `/projects/${id}/entries`,
    `/projects/${id}/accesses`,
    `/projects/${id}/access-logs`,
    `/projects/${id}/logs`,
    `/projects/${id}/checkins`,
    `/projects/${id}/check-ins`,
    `/projects/${id}/events`,
    `/projects/${id}/attendances`,
    `/projects/${id}/presences`,
    `/scans?project_id=${id}`,
    `/scans?projectId=${id}`,
    `/events?project_id=${id}`,
    `/attendances?project_id=${id}`,
    `/projects/${id}`,
  ];

  let fallback = null;
  for (const ep of candidates) {
    const url = `${API_BASE}${ep}`;
    try {
      const result = await request(url, project.apiKey);
      if (!result) continue;
      const { res, authHeaders } = result;
      if (res.status === 200) {
        const sample = res.body;
        const rows = extractRows(sample);
        // Skip generic project-info endpoints that return a plain object (not a list)
        if (!Array.isArray(sample) && rows.length === 0 && !Array.isArray(sample?.data)) {
          console.log(`  ~ ${ep} → 200 but looks like project info, not a list. Keys: ${Object.keys(sample || {}).join(', ')}`);
          // Keep it as fallback — store it but keep searching
          if (!fallback) fallback = { endpoint: ep, sample, authHeaders };
          continue;
        }
        console.log(`  ✓ Found list endpoint: ${ep}`);
        return { endpoint: ep, sample, authHeaders };
      } else if (res.status !== 404) {
        console.log(`  ? ${ep} → HTTP ${res.status} | body: ${JSON.stringify(res.body).slice(0, 200)}`);
      }
    } catch (e) {
      console.error(`  ✗ ${ep} → ${e.message}`);
    }
  }
  if (fallback) {
    console.log(`  ~ Using project-info endpoint as fallback: ${fallback.endpoint}`);
    console.log(`    Response keys: ${Object.keys(fallback.sample || {}).join(', ')}`);
  }
  return fallback;
}

function extractRows(body) {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    return body.data || body.scans || body.results || body.items || body.records || body.entries || [];
  }
  return [];
}

async function fetchAllScans(project, baseEndpoint, authHeaders, date = TARGET_DATE) {
  const dayStart = `${date}T00:00:00Z`;
  const dayEnd   = `${date}T23:59:59Z`;

  const dateParamSets = [
    `start=${dayStart}&end=${dayEnd}`,
    `start_date=${date}&end_date=${date}`,
    `from=${dayStart}&to=${dayEnd}`,
    `date=${date}`,
    `createdAt[gte]=${dayStart}&createdAt[lte]=${dayEnd}`,
    `scanned_at[gte]=${dayStart}&scanned_at[lte]=${dayEnd}`,
    `created_at_start=${dayStart}&created_at_end=${dayEnd}`,
    '', // no date filter — will filter client-side
  ];

  let allScans = [];
  let usedParams = null;

  for (const params of dateParamSets) {
    const sep = baseEndpoint.includes('?') ? '&' : '?';
    const qs = params ? `${sep}${params}&limit=1000&page=1` : `${sep}limit=1000&page=1`;
    const url = `${API_BASE}${baseEndpoint}${qs}`;
    try {
      const res = await requestWithHeaders(url, authHeaders);
      if (res.status === 200) {
        const rows = extractRows(res.body);
        if (params) {
          console.log(`  ✓ Date filter: ${params} → ${rows.length} row(s)`);
          allScans = rows;
          usedParams = params;
        } else {
          // No date filter — filter client-side
          const filtered = rows.filter(s => {
            const ts = s.scanned_at || s.scannedAt || s.created_at || s.createdAt || s.timestamp || s.date || '';
            return typeof ts === 'string' && ts.startsWith(date);
          });
          console.log(`  ⚠ No date filter — fetched ${rows.length} row(s), ${filtered.length} match ${date}`);
          allScans = filtered;
          usedParams = '';
        }
        break;
      }
    } catch { /* try next */ }
  }

  // Paginate using the working auth headers
  if (allScans.length > 0 && usedParams) {
    let page = 2;
    while (true) {
      const sep = baseEndpoint.includes('?') ? '&' : '?';
      const url = `${API_BASE}${baseEndpoint}${sep}${usedParams}&limit=1000&page=${page}`;
      try {
        const res = await requestWithHeaders(url, authHeaders);
        if (res.status !== 200) break;
        const chunk = extractRows(res.body);
        if (chunk.length === 0) break;
        allScans = allScans.concat(chunk);
        page++;
        if (page > 50) break;
      } catch { break; }
    }
  }

  return allScans;
}

function flattenObject(obj, prefix = '') {
  const result = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(result, flattenObject(v, key));
    } else if (Array.isArray(v)) {
      result[key] = JSON.stringify(v);
    } else {
      result[key] = v;
    }
  }
  return result;
}

function toCSV(rows) {
  if (!rows || rows.length === 0) return 'No data found\n';

  const flat = rows.map(r => flattenObject(r));
  const headers = [...new Set(flat.flatMap(r => Object.keys(r)))].sort();

  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const lines = [
    headers.join(','),
    ...flat.map(r => headers.map(h => escape(r[h])).join(',')),
  ];
  return lines.join('\n') + '\n';
}

async function main() {
  console.log(`\nFetching scans for ${TARGET_DATE}\n${'='.repeat(50)}`);

  const outputDir = path.join(__dirname, 'exports');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

  for (const project of PROJECTS) {
    console.log(`\n[${project.name}] ${project.label}`);

    // 1. Discover a working endpoint
    console.log('  Discovering endpoints…');
    const discovery = await discoverEndpoints(project);

    if (!discovery) {
      console.error('  ✗ No working endpoint found. Skipping.');
      continue;
    }

    // 2. Try both possible years (user said "May 8th" without a year)
    const datesToTry = TARGET_DATE === '2026-05-08'
      ? ['2026-05-08', '2025-05-08']
      : [TARGET_DATE];

    let scans = [];
    let usedDate = TARGET_DATE;
    for (const d of datesToTry) {
      console.log(`  Fetching scans for ${d}…`);
      const rows = await fetchAllScans(project, discovery.endpoint, discovery.authHeaders, d);
      if (rows.length > 0) { scans = rows; usedDate = d; break; }
      console.log(`  → 0 rows for ${d}`);
    }
    console.log(`  → ${scans.length} scan(s) found (date: ${usedDate})`);

    // 3. Write CSV
    const filename = path.join(outputDir, `scans_${project.name}_${usedDate}.csv`);
    const csv = toCSV(scans);
    fs.writeFileSync(filename, csv, 'utf8');
    console.log(`  ✓ Saved: ${filename}`);
  }

  console.log('\nDone.\n');
}

main().catch((e) => { console.error('Fatal error:', e); process.exit(1); });
