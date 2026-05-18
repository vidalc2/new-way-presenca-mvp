#!/usr/bin/env node
// Brute-force API discovery — tries every plausible endpoint and logs any non-404 response.
// Usage: TRST_JPA_API_KEY="..." TRST_CG_API_KEY="..." node discover.js

const https = require('https');

const PROJECTS = [
  {
    name: 'JPA',
    projectId: '019ca04b-4abf-774b-8240-68bb547dbae5',
    envId:     '019ca049-cf4a-7860-9f57-033147e76f13',
    apiKey: process.env.TRST_JPA_API_KEY,
  },
  {
    name: 'CG',
    projectId: '019c92ae-d49d-77eb-aa27-8cb0b3ea6b7d',
    envId:     '019c92ae-d49b-7266-ad76-ad9da9b4de1d',
    apiKey: process.env.TRST_CG_API_KEY,
  },
];

const API_BASE = 'https://api.prod-brl.trstinc.ca/v1';

function get(url, apiKey) {
  return new Promise((resolve) => {
    const [keyId, keySecret] = (apiKey || '').split('.');
    const basic = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    const headers = { 'Authorization': `Basic ${basic}`, 'Accept': 'application/json' };
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, headers }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', e => resolve({ status: 0, body: e.message }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    req.end();
  });
}

async function probe(url, apiKey, label) {
  const r = await get(url, apiKey);
  if (r.status === 404) return; // skip silently
  const body = JSON.stringify(r.body);
  const interesting = r.status === 200 || (r.status !== 401 && r.status !== 403);
  const flag = r.status === 200 ? '✓' : '?';
  console.log(`  ${flag} [${r.status}] ${label} → ${body.slice(0, 200)}`);
}

async function main() {
  for (const p of PROJECTS) {
    if (!p.apiKey) { console.log(`\n[${p.name}] skipped — no API key`); continue; }
    console.log(`\n${'='.repeat(60)}\n[${p.name}] project=${p.projectId} env=${p.envId}\n${'='.repeat(60)}`);

    const id  = p.projectId;
    const env = p.envId;
    const key = p.apiKey;

    // ── Top-level resources ──────────────────────────────────────
    const roots = ['projects','environments','scans','events','transactions','people',
                   'members','persons','users','identities','holders','cardholders',
                   'access-logs','access_logs','entries','attendances','presences',
                   'visits','passes','records','logs','checkins','reports'];
    console.log('\n── Root endpoints ──');
    for (const r of roots) await probe(`${API_BASE}/${r}?page=1&per_page=5`, key, `/${r}`);

    // ── Project-scoped resources ─────────────────────────────────
    const subs = ['scans','scan-logs','scan_logs','entries','accesses','access-logs','access_logs',
                  'logs','checkins','check-ins','events','transactions','attendances','presences',
                  'passes','visits','records','people','members','persons','users','identities',
                  'holders','cardholders','biometric-events','access-events','door-events',
                  'reports','history','timeline','activity','audit','audit-logs','audit_logs'];
    console.log('\n── /projects/{id}/... ──');
    for (const s of subs) await probe(`${API_BASE}/projects/${id}/${s}?page=1&per_page=5`, key, `/projects/${id}/${s}`);

    // ── Environment-scoped resources ─────────────────────────────
    console.log('\n── /environments/{envId}/... ──');
    for (const s of subs) await probe(`${API_BASE}/environments/${env}/${s}?page=1&per_page=5`, key, `/environments/${env}/${s}`);

    // ── Date-param variants for transactions ─────────────────────
    console.log('\n── Transactions with date params ──');
    const dateVariants = [
      'from=2026-05-08T00%3A00%3A00Z&to=2026-05-09T00%3A00%3A00Z&page=1&per_page=10',
      'from=2026-05-08T00:00:00Z&to=2026-05-09T00:00:00Z&page=1&per_page=10',
      'from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z&page=1&per_page=10',
    ];
    for (const dv of dateVariants) {
      await probe(`${API_BASE}/projects/${id}/transactions?${dv}`, key, `/projects/${id}/transactions?${dv.slice(0,40)}…`);
      await probe(`${API_BASE}/environments/${env}/transactions?${dv}`, key, `/environments/${env}/transactions?${dv.slice(0,40)}…`);
    }
  }
  console.log('\nDone.\n');
}

main().catch(e => { console.error(e); process.exit(1); });
