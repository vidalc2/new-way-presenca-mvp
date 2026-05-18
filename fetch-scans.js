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

function request(url, apiKey) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'X-API-Key': apiKey,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
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

async function discoverEndpoints(project) {
  const candidates = [
    `/projects/${project.projectId}/scans`,
    `/scans?project_id=${project.projectId}`,
    `/scans?projectId=${project.projectId}`,
    `/projects/${project.projectId}/events`,
    `/events?project_id=${project.projectId}`,
    `/projects/${project.projectId}/attendances`,
    `/attendances?project_id=${project.projectId}`,
    `/projects/${project.projectId}`,
  ];

  for (const ep of candidates) {
    const url = `${API_BASE}${ep}`;
    try {
      const res = await request(url, project.apiKey);
      if (res.status === 200) {
        console.log(`  ✓ Found working endpoint: ${ep}`);
        return { endpoint: ep, sample: res.body };
      } else if (res.status !== 404) {
        console.log(`  ? ${ep} → HTTP ${res.status}`);
      }
    } catch (e) {
      console.error(`  ✗ ${ep} → ${e.message}`);
    }
  }
  return null;
}

async function fetchAllScans(project, baseEndpoint) {
  const dayStart = `${TARGET_DATE}T00:00:00Z`;
  const dayEnd = `${TARGET_DATE}T23:59:59Z`;

  // Try various date filter param conventions
  const dateParamSets = [
    `start=${dayStart}&end=${dayEnd}`,
    `start_date=${TARGET_DATE}&end_date=${TARGET_DATE}`,
    `from=${dayStart}&to=${dayEnd}`,
    `date=${TARGET_DATE}`,
    `createdAt[gte]=${dayStart}&createdAt[lte]=${dayEnd}`,
    `scanned_at[gte]=${dayStart}&scanned_at[lte]=${dayEnd}`,
  ];

  let allScans = [];
  let usedParams = '';

  for (const params of dateParamSets) {
    const sep = baseEndpoint.includes('?') ? '&' : '?';
    const url = `${API_BASE}${baseEndpoint}${sep}${params}&limit=1000&page=1`;
    try {
      const res = await request(url, project.apiKey);
      if (res.status === 200) {
        console.log(`  ✓ Date params work: ${params}`);
        usedParams = params;
        const body = res.body;
        // Handle various response shapes: array, {data:[]}, {scans:[]}, {results:[]}, {items:[]}
        if (Array.isArray(body)) {
          allScans = body;
        } else if (body && typeof body === 'object') {
          allScans = body.data || body.scans || body.results || body.items || body.records || [];
        }
        break;
      }
    } catch (e) {
      // try next
    }
  }

  // If no date filter worked, fetch without date and filter client-side
  if (allScans.length === 0 && usedParams === '') {
    console.log('  ⚠ No date filter worked, fetching all and filtering client-side…');
    const url = `${API_BASE}${baseEndpoint}${baseEndpoint.includes('?') ? '&' : '?'}limit=1000`;
    try {
      const res = await request(url, project.apiKey);
      if (res.status === 200) {
        const body = res.body;
        const all = Array.isArray(body) ? body :
          (body && typeof body === 'object' ? (body.data || body.scans || body.results || body.items || []) : []);
        allScans = all.filter(s => {
          const ts = s.scanned_at || s.scannedAt || s.created_at || s.createdAt || s.timestamp || s.date || '';
          return typeof ts === 'string' && ts.startsWith(TARGET_DATE);
        });
      }
    } catch (e) {
      console.error(`  ✗ Fallback fetch failed: ${e.message}`);
    }
  }

  // Paginate if needed
  if (allScans.length > 0 && usedParams) {
    let page = 2;
    while (true) {
      const sep = baseEndpoint.includes('?') ? '&' : '?';
      const url = `${API_BASE}${baseEndpoint}${sep}${usedParams}&limit=1000&page=${page}`;
      try {
        const res = await request(url, project.apiKey);
        if (res.status !== 200) break;
        const body = res.body;
        const chunk = Array.isArray(body) ? body :
          (body && typeof body === 'object' ? (body.data || body.scans || body.results || body.items || []) : []);
        if (chunk.length === 0) break;
        allScans = allScans.concat(chunk);
        page++;
        if (page > 50) break; // safety cap
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

    // 2. Fetch scans for the target date
    console.log(`  Fetching scans for ${TARGET_DATE}…`);
    const scans = await fetchAllScans(project, discovery.endpoint);
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
