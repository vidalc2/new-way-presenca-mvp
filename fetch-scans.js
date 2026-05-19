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
    apiKey: process.env.TRST_JPA_API_KEY,
  },
  {
    name: 'CG',
    label: 'New Way CG (Campina Grande)',
    projectId: '019c92ae-d49d-77eb-aa27-8cb0b3ea6b7d',
    apiKey: process.env.TRST_CG_API_KEY,
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

async function getProjectInfo(project) {
  const result = await request(`${API_BASE}/projects/${project.projectId}`, project.apiKey);
  if (result && result.res.status === 200) return { info: result.res.body, authHeaders: result.authHeaders };
  return null;
}

async function discoverEndpoints(project) {
  const id = project.projectId;

  // First, fetch project info to grab environment_id and other IDs
  const proj = await getProjectInfo(project);
  const envId = proj?.info?.environment_id;
  const authHeaders = proj?.authHeaders;

  if (envId) console.log(`  environment_id: ${envId}`);

  // First: try fetching people/members to understand data model
  console.log('  Probing people/members endpoints…');
  const peopleSubs = ['people','members','persons','users','identities','holders','cardholders',
                      'employees','students','staff'];
  for (const sub of peopleSubs) {
    for (const base of [`/projects/${id}`, envId ? `/environments/${envId}` : null].filter(Boolean)) {
      const ep = `${base}/${sub}`;
      try {
        const res = await requestWithHeaders(`${API_BASE}${ep}?page=1&per_page=5`, authHeaders);
        if (res.status === 200) {
          console.log(`  ✓ People endpoint: ${ep} → ${JSON.stringify(res.body).slice(0, 200)}`);
        } else if (res.status !== 404) {
          console.log(`  ? ${ep} → ${res.status} | ${JSON.stringify(res.body).slice(0, 100)}`);
        }
      } catch { /* skip */ }
    }
  }

  // Build candidate list — project-level, environment-level, and root-level
  const candidates = [];

  // Project-scoped
  for (const sub of ['scans','scan-logs','scan_logs','entries','accesses','access-logs',
                      'access_logs','logs','checkins','check-ins','events','transactions',
                      'attendances','presences','passes','visits','records','biometric-events',
                      'access-events','door-events','gate-events','identity-events']) {
    candidates.push(`/projects/${id}/${sub}`);
  }

  // Environment-scoped
  if (envId) {
    for (const sub of ['scans','scan-logs','scan_logs','entries','accesses','access-logs',
                       'access_logs','logs','checkins','check-ins','events','transactions',
                       'attendances','presences','passes','visits','records','biometric-events',
                       'access-events','door-events','gate-events','identity-events']) {
      candidates.push(`/environments/${envId}/${sub}`);
    }
    candidates.push(`/environments/${envId}`);
  }

  // Root-level with filters
  for (const param of [`project_id=${id}`, `projectId=${id}`]) {
    for (const ep of ['scans','events','access-logs','transactions','entries']) {
      candidates.push(`/${ep}?${param}`);
    }
  }
  if (envId) {
    for (const param of [`environment_id=${envId}`, `environmentId=${envId}`]) {
      for (const ep of ['scans','events','access-logs','transactions','entries']) {
        candidates.push(`/${ep}?${param}`);
      }
    }
  }

  // Probe all candidates — collect ALL that need date params, try each with actual dates
  const needsParams = [];

  for (const ep of candidates) {
    const url = `${API_BASE}${ep}`;
    try {
      const result = authHeaders
        ? { res: await requestWithHeaders(url, authHeaders), authHeaders }
        : await request(url, project.apiKey);
      if (!result) continue;
      const { res, authHeaders: ah } = result;
      if (res.status === 200) {
        const sample = res.body;
        const rows = extractRows(sample);
        if (!Array.isArray(sample) && rows.length === 0 && !Array.isArray(sample?.data)) {
          console.log(`  ~ ${ep} → 200 (object). Keys: ${Object.keys(sample || {}).join(', ')}`);
          continue;
        }
        console.log(`  ✓ Found list endpoint: ${ep} (${rows.length} rows in sample)`);
        return { endpoint: ep, sample, authHeaders: ah };
      } else if (res.status === 400) {
        const body = JSON.stringify(res.body);
        if (body.includes('from') || body.includes('date') || body.includes('parse') || body.includes('required')) {
          console.log(`  ~ ${ep} → needs date params`);
          needsParams.push({ ep, authHeaders: ah });
        }
        console.log(`  ? ${ep} → HTTP 400 | ${body.slice(0, 150)}`);
      } else if (res.status !== 404) {
        console.log(`  ? ${ep} → HTTP ${res.status} | ${JSON.stringify(res.body).slice(0, 150)}`);
      }
    } catch (e) {
      console.error(`  ✗ ${ep} → ${e.message}`);
    }
  }

  // For each candidate that needs date params, try with actual dates and pick first with data
  if (needsParams.length > 0) {
    console.log(`  Probing ${needsParams.length} date-param endpoints with real dates…`);
    const testFrom = '2020-01-01T00:00:00Z';
    const testTo   = '2030-01-01T00:00:00Z';
    for (const { ep, authHeaders: ah } of needsParams) {
      try {
        const sep = ep.includes('?') ? '&' : '?';
        const url = `${API_BASE}${ep}${sep}from=${testFrom}&to=${testTo}&page=1&per_page=10`;
        const res = await requestWithHeaders(url, ah);
        const total = res.body?.total_count ?? '?';
        console.log(`  [${res.status}] ${ep} → total_count: ${total} | ${JSON.stringify(res.body).slice(0,120)}`);
        if (res.status === 200 && (res.body?.total_count > 0 || extractRows(res.body).length > 0)) {
          console.log(`  ✓ Has data: ${ep}`);
          return { endpoint: ep, authHeaders: ah };
        }
      } catch (e) {
        console.log(`  ✗ ${ep} → ${e.message}`);
      }
    }
    // Return first one anyway so fetch can try different date formats
    const first = needsParams[0];
    console.log(`  ~ All returned 0. Using first: ${first.ep}`);
    return { endpoint: first.ep, authHeaders: first.authHeaders };
  }

  if (proj) {
    console.log(`  ✗ No endpoint found. Project keys: ${Object.keys(proj.info).join(', ')}`);
  }
  return null;
}

function extractRows(body) {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    return body.data || body.scans || body.results || body.items || body.records || body.entries || [];
  }
  return [];
}

async function trystRequest(baseEndpoint, authHeaders, from, to, page = 1, perPage = 1000) {
  const sep = baseEndpoint.includes('?') ? '&' : '?';
  const url = `${API_BASE}${baseEndpoint}${sep}from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&page=${page}&per_page=${perPage}`;
  const res = await requestWithHeaders(url, authHeaders);
  return res;
}

async function fetchAllScans(project, baseEndpoint, authHeaders, date = TARGET_DATE) {
  const dayStart = `${date}T00:00:00Z`;
  const dayEnd   = `${date}T23:59:59Z`;

  // Try UTC and local (no-Z) datetime formats
  const fromVariants = [dayStart, dayStart.replace('Z',''), `${date}T00:00:00-03:00`];
  const toVariants   = [dayEnd,   dayEnd.replace('Z',''),   `${date}T23:59:59-03:00`];

  let res = null;
  let allRows = [];
  let total = 0;

  for (let i = 0; i < fromVariants.length; i++) {
    res = await trystRequest(baseEndpoint, authHeaders, fromVariants[i], toVariants[i]);
    total = res.body?.total_count ?? 0;
    console.log(`    [${res.status}] from=${fromVariants[i]} → total_count: ${total}`);
    if (res.status === 200 && total > 0) {
      allRows = extractRows(res.body);
      break;
    }
  }

  if (res?.status !== 200) return [];
  if (total === 0) {
    // Widen search to find any data at all
    const checks = [
      [`${date.slice(0,7)}-01T00:00:00Z`, `${date.slice(0,7)}-31T23:59:59Z`, 'whole month'],
      ['2020-01-01T00:00:00Z', '2030-01-01T00:00:00Z', 'all-time'],
    ];
    for (const [f, t, label] of checks) {
      const r = await trystRequest(baseEndpoint, authHeaders, f, t);
      const n = r.body?.total_count ?? 0;
      console.log(`    → ${n} record(s) ${label} | sample: ${JSON.stringify(r.body).slice(0,150)}`);
      if (n > 0) break;
    }
    return [];
  }

  // Paginate remaining pages
  const perPage = 1000;
  const totalPages = Math.ceil(total / perPage);
  for (let page = 2; page <= totalPages && page <= 50; page++) {
    const pRes = await trystRequest(baseEndpoint, authHeaders, dayStart, dayEnd, page, perPage);
    if (pRes.status !== 200) break;
    allRows = allRows.concat(extractRows(pRes.body));
  }

  return allRows;
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

    // 2. Fetch scans — also probes wider ranges if 0 results
    console.log(`  Fetching scans for ${TARGET_DATE}…`);
    const scans = await fetchAllScans(project, discovery.endpoint, discovery.authHeaders, TARGET_DATE);
    console.log(`  → ${scans.length} scan(s) found`);

    // 3. Write CSV
    const filename = path.join(outputDir, `scans_${project.name}_${TARGET_DATE}.csv`);
    const csv = toCSV(scans);
    fs.writeFileSync(filename, csv, 'utf8');
    console.log(`  ✓ Saved: ${filename}`);
  }

  console.log('\nDone.\n');
}

main().catch((e) => { console.error('Fatal error:', e); process.exit(1); });
