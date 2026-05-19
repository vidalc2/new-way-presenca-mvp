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
    // Try Bearer first (works for TRST v1), fallback to Basic split-key
    const [keyId, keySecret] = (apiKey || '').split('.');
    const basic = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    const authVariants = [
      `Bearer ${apiKey}`,
      `Basic ${basic}`,
      `ApiKey ${apiKey}`,
    ];

    function tryAuth(idx) {
      if (idx >= authVariants.length) return resolve({ status: 0, body: 'all auth failed' });
      const u = new URL(url);
      const req = https.request({
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: { 'Authorization': authVariants[idx], 'Accept': 'application/json' },
      }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          const body = (() => { try { return JSON.parse(d); } catch { return d; } })();
          if ((res.statusCode === 401 || res.statusCode === 403) && idx + 1 < authVariants.length) {
            return tryAuth(idx + 1);
          }
          resolve({ status: res.statusCode, body, authUsed: authVariants[idx].split(' ')[0] });
        });
      });
      req.on('error', e => resolve({ status: 0, body: e.message }));
      req.setTimeout(15000, () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
      req.end();
    }
    tryAuth(0);
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
    const subs = [
      // biometric / presence-check specific
      'lookups','server-lookups','server_lookups','verifications','biometrics',
      'biometric-verifications','biometric_verifications','identity-checks','identity_checks',
      'presence','presence-checks','presence_checks','authentications','face-scans','palm-scans',
      'finger-scans','enrollments','matches','recognitions','detections',
      // access control
      'scans','scan-logs','scan_logs','entries','accesses','access-logs','access_logs',
      'logs','checkins','check-ins','events','transactions','attendances','presences',
      'passes','visits','records','people','members','persons','users','identities',
      'holders','cardholders','biometric-events','access-events','door-events',
      'reports','history','timeline','activity','audit','audit-logs','audit_logs',
    ];
    console.log('\n── /projects/{id}/... ──');
    for (const s of subs) await probe(`${API_BASE}/projects/${id}/${s}?page=1&per_page=5`, key, `/projects/${id}/${s}`);

    // ── Environment-scoped resources ─────────────────────────────
    console.log('\n── /environments/{envId}/... ──');
    for (const s of subs) await probe(`${API_BASE}/environments/${env}/${s}?page=1&per_page=5`, key, `/environments/${env}/${s}`);

    // ── Date-param variants for biometric/scan endpoints ─────────
    console.log('\n── Biometric endpoints with date params ──');
    const qs = 'from=2020-01-01T00:00:00Z&to=2030-01-01T00:00:00Z&page=1&per_page=10';
    const qs2 = 'page=1&per_page=10';
    const bioEps = ['lookups','server-lookups','verifications','biometrics','presence',
                    'scans','events','transactions','authentications','matches'];
    for (const ep of bioEps) {
      await probe(`${API_BASE}/projects/${id}/${ep}?${qs}`, key, `/projects/${id}/${ep}?from=2020…`);
      await probe(`${API_BASE}/projects/${id}/${ep}?${qs2}`, key, `/projects/${id}/${ep}?page=1`);
      await probe(`${API_BASE}/environments/${env}/${ep}?${qs}`, key, `/environments/${env}/${ep}?from=2020…`);
      await probe(`${API_BASE}/environments/${env}/${ep}?${qs2}`, key, `/environments/${env}/${ep}?page=1`);
    }
  }
  console.log('\nDone.\n');
}

main().catch(e => { console.error(e); process.exit(1); });
