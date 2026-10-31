# Public release verification

The original development checkout recorded 1,322 / 1,322 offline tests, successful Web type/build checks and desktop/mobile browser verification. A clean same-machine checkout passed the identical suite with two test files concurrent. The earlier default-parallel native exit 0xC0000005 remains unexplained.

During publication preparation we identified two historical fixture readers that followed old absolute paths. The public release copies the four exact historical store specimens into `tests/fixtures/historical-recovery` and changes only test input resolution. Archived evidence bytes and production publication/cleanup checks are unchanged. A focused decision-binding test run passed 5 / 5 after this change.

Public release checks on 2026-11-01 (Shanghai):

- Frozen dependency install: passed.
- Fresh official data clone and pinned checkout: passed.
- Server build and Web type check / production build: passed.
- Complete original offline suite in the curated public tree: **1,322 / 1,322**, no skips, exit 0, 368.478 seconds with two test files concurrent.
- New public-demo adapter checks: **3 / 3** separately. They cover denied write/missing API requests, saved event-stream media type and unchanged normal local fetch.
- Static archive: 545 captured GET routes; every payload size/hash matches the manifest, all nine event streams are contiguous through the saved last sequence, and every cited Evidence response is present.
- Secret scan: zero matches for the configured real credentials; no unexplained key/private-key pattern. One explicit offline test-key literal is identified as a fixture.
- The hosting service confirms successful deployment with public access mode. Local unauthenticated HTTP verification encountered a Cloudflare access block. Public browser verification is still pending; do not interpret platform deployment status as proof of universal reachability.

These checks do not make a live model request or establish semantic matching accuracy. The new UI variant has not yet received browser QA because the connected browser could enumerate tabs but timed out when reading pages; the original local views previously received desktop and mobile QA.

To run the complete suite with bounded file concurrency after building:

```powershell
node --input-type=module -e "import {discoverTestFiles} from './scripts/test-offline.mjs'; import {spawnSync} from 'node:child_process'; const r=spawnSync(process.execPath,['--test','--test-concurrency=2',...discoverTestFiles(process.cwd())],{stdio:'inherit',windowsHide:true}); process.exitCode=r.status ?? 1;"
```
