# NS EZ Interco Dist

Split a vendor bill line to another subsidiary right on the bill, and have NetSuite post the intercompany entry when the bill saves.

## Why

NetSuite's Transaction Line Distribution SuiteApp works off saved rules (percentages or amounts). That's fine for splits that repeat every month. For one-off splits you end up building a template you'll use once. Other ERPs let you just put a second business unit on the line, and this gets close to that.

## What happens on save

Pick a target subsidiary on an Expense line (optionally a different account and/or a partial amount). After the bill saves, a user event creates one Advanced Intercompany Journal Entry for the bill:

| Subsidiary | Debit | Credit |
|---|---|---|
| Bill's subsidiary | Interco AR (due from target) | The line's expense account |
| Target subsidiary | Expense account (target account if set) | Interco AP (due to source) |

- Only the Interco AR and AP lines are marked Eliminate. The expense lines already net to zero in consolidation.
- Several split lines on one bill go into the same JE.
- The JE's internal id is written to the bill's `custbody_ic_related_je`.

It skips a line (and logs why in the script's execution log) when:

- either subsidiary isn't marked Elimination Confirmed on the mapping record, or has no mapping
- the target is the bill's own subsidiary
- the allocation amount is more than the line amount
- the line is on the Item sublist (see Known gaps)

Editing a bill that already has a related JE doesn't post a second one. If the split changes after the first save, adjust that JE by hand. A copied bill (Make Copy) gets its own JE, since the copy carries over the old link.

If the JE fails to save, the bill still saves and the error goes to the execution log.

## Only confirmed pairs

The script doesn't try to handle every subsidiary pair. Both subsidiaries need Elimination Confirmed checked on their mapping row, meaning someone has checked there's a real consolidation point (a shared parent with an elimination subsidiary) between them. Anything else saves normally and gets entered by hand. A wrong intercompany entry is worse than none.

## Custom objects

Create these in the sandbox UI, then pull them into `src/Objects` with `suitecloud object:import` if you want them in the project. They aren't checked in yet.

**Custom record `customrecord_ic_subsidiary_map`** (one row per subsidiary)

| Field ID | Label | Type |
|---|---|---|
| `custrecord_ic_subsidiary` | Subsidiary | List/Record: Subsidiary |
| `custrecord_ic_ar_account` | Interco AR Account (Due From) | List/Record: Account |
| `custrecord_ic_ap_account` | Interco AP Account (Due To) | List/Record: Account |
| `custrecord_ic_elim_confirmed` | Elimination Confirmed | Checkbox |

**Transaction column fields** (Vendor Bill, Expense sublist)

| Field ID | Type |
|---|---|
| `custcol_ic_target_subsidiary` | List/Record: Subsidiary |
| `custcol_ic_target_account` | List/Record: Account |
| `custcol_ic_target_amount` | Currency |
| `custcol_ic_memo` | Free-Form Text |

**Transaction body field** (Vendor Bill)

| Field ID | Type |
|---|---|
| `custbody_ic_related_je` | List/Record: Transaction |

## Project layout and deploy

```
suitecloud.config.js
src/
  manifest.xml
  deploy.xml
  FileCabinet/SuiteScripts/ic_bill_allocation_ue.js
test/
```

```
suitecloud account:setup     # point at the sandbox
suitecloud project:deploy
```

Then create the script record and deployment on Vendor Bill (After Submit). Keep the deployment in **Testing**, with the audience limited to your own role, until it's been through a full close in sandbox. Releasing it is a separate, deliberate step.

## Tests

```
npm test
```

The tests run the script against stand-ins for `N/record`, `N/search` and `N/log`. They check what the script posts and when (balanced lines per subsidiary, no duplicate JE on edit, skip rules). They don't prove NetSuite will accept the record, which only the sandbox can do.

## Known gaps

- **Item lines.** An item line posts to the item's own account (expense, asset or COGS depending on the item), which isn't on the bill line, so there's nothing safe to credit. Item lines with a target subsidiary are logged and skipped.
- **Due To/From Subsidiary.** If your Interco AR/AP accounts require it on the line, NetSuite fills it from the line's Name (the intercompany customer or vendor). The script doesn't set a Name yet, so those accounts will make the save fail and the error will show in the log.
- **Field IDs to confirm.** `linesubsidiary` and `eliminate` on the AICJE line sublist come from working examples, not Oracle's reference. Check them in the Records Browser for your account before the first sandbox run.
- **Currency.** Not tested with subsidiaries on different base currencies.

## Roadmap

- Item line support (look up the posting account per item type).
- Same split on AR invoices.
- Move the deployment from Testing to Released once it's been through a close.

## Status

Early build, sandbox only. Not affiliated with or endorsed by Oracle NetSuite.
