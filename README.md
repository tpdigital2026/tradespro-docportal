# TradesPro DocPortal

Branded trade paperwork from a short form. See `docs/superpowers/specs/` for the design and `docs/superpowers/plans/` for the build plans.

## Scripts

- `npm test` runs fast unit tests.
- `npm run test:render` runs Chromium rendering tests. It needs Chrome and the reference zip extracted to `reference/` (see below).
- `npm run spike` renders the quotation to `out/`.

## Reference material (not committed)

```bash
mkdir -p reference && unzip -q ~/Downloads/DocPortal_Reference.zip -d reference
```
