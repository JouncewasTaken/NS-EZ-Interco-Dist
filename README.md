# NS EZ Interco Dist

Allows allocating a vendor bill line across subsidiaries directly from the bill entry screen, instead of building a distribution template for every one-off intercompany split.

## Problem

NetSuite's Transaction Line Distribution SuiteApp allocates by predefined percentage or amount rules. That works when splits repeat. It breaks down when every intercompany bill has a different, one-off split, since each one needs its own throwaway template.

This project adds a target subsidiary directly to the bill line, and generates the corresponding Advanced Intercompany Journal Entry (AICJE) on save — closer to entering a second line with a different business unit the way some other ERPs handle intercompany distribution.

## How it works

1. A custom record, `customrecord_ic_subsidiary_map`, maps each subsidiary to its own Interco AP (Due-To) and Interco AR (Due-From) accounts, plus an Elimination Confirmed flag.
2. Custom line fields on the bill's Item and Expense sublists let the user set a target subsidiary, account, amount, and memo per line.
3. A User Event script (`afterSubmit`) reads any line with a target subsidiary populated and generates a 4-line AICJE:
   - Source subsidiary: debit Interco AR, credit the original expense account
   - Target subsidiary: debit the expense account, credit Interco AP
   - Each line flagged for elimination
4. The generated journal entry's internal ID is written back to the bill for traceability.

## Deliberate scope limits

This does **not** attempt automated elimination for every subsidiary pair. It only fires when both the source and target subsidiary are marked Elimination Confirmed on the mapping record — meaning someone has verified there's a real consolidation point (a shared parent with an elimination subsidiary) between them.

Any pair without a confirmed mapping is left alone. No journal entry is generated, and the bill saves normally for manual entry. Guessing at an accounting treatment that hasn't been verified is worse than doing nothing.

## Custom objects

These are documented here rather than checked in as hand-authored XML, since custom record/field XML is best pulled accurately via `suitecloud object:import` after creating the objects in a sandbox UI, rather than hand-written from scratch.

**Custom record: `customrecord_ic_subsidiary_map`** (one row per subsidiary)

| Field | Type |
|---|---|
| Subsidiary | List/Record → Subsidiary |
| Interco AR Account (Due-From) | List/Record → Account |
| Interco AP Account (Due-To) | List/Record → Account |
| Elimination Confirmed | Checkbox |

**Custom transaction column fields** (applied to Vendor Bill Item and Expense sublists)

| Field ID | Type |
|---|---|
| `custcol_ic_target_subsidiary` | List/Record → Subsidiary |
| `custcol_ic_target_account` | List/Record → Account |
| `custcol_ic_target_amount` | Currency |
| `custcol_ic_memo` | Free-Form Text |

**Custom body field** (Vendor Bill)

| Field ID | Type |
|---|---|
| `custbody_ic_related_je` | List/Record → Transaction |

## Deployment

- Deployment status: **Testing**, audience scoped to the developer's own role, until validated across a full accounting cycle in sandbox.
- Never let the deployment default to Released — that's a deliberate, separate step.

## Roadmap

- Extend the same mapping and generation logic to AR invoices, not just AP bills.
- Move from Testing status / scoped audience to fully Released once validated.

## Status

Early build. Intended to be developed and tested in a NetSuite sandbox before any production deployment. Not affiliated with or endorsed by Oracle NetSuite.
