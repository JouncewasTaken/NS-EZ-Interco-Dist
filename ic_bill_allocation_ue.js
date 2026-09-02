/**
 * NS EZ Interco Dist
 * User Event script — Vendor Bill
 *
 * On save, reads any Item/Expense line with a target subsidiary populated
 * and generates a 4-line Advanced Intercompany Journal Entry moving the
 * cost from the source subsidiary to the target subsidiary, flagged for
 * elimination.
 *
 * Deliberately does nothing for any subsidiary pair that isn't marked
 * Elimination Confirmed in customrecord_ic_subsidiary_map — those bills
 * save normally and fall through to manual entry.
 *
 * NOTE before deploying: verify these against your account before trusting
 * them — internal field IDs on the AICJE line sublist (e.g. the exact ID
 * for the Eliminate checkbox, and the record.Type constant for Advanced
 * Intercompany Journal Entry) should be confirmed via the record browser
 * in your own sandbox rather than assumed from this skeleton.
 *
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/log', 'N/search'], (record, log, search) => {

  const MAP_RECORD = 'customrecord_ic_subsidiary_map';
  const MAP_SUBSIDIARY_FIELD = 'custrecord_ic_subsidiary';
  const MAP_AR_FIELD = 'custrecord_ic_ar_account';
  const MAP_AP_FIELD = 'custrecord_ic_ap_account';
  const MAP_CONFIRMED_FIELD = 'custrecord_ic_elim_confirmed';

  const TARGET_SUB_FIELD = 'custcol_ic_target_subsidiary';
  const TARGET_ACCT_FIELD = 'custcol_ic_target_account';
  const TARGET_AMT_FIELD = 'custcol_ic_target_amount';
  const MEMO_FIELD = 'custcol_ic_memo';
  const RELATED_JE_FIELD = 'custbody_ic_related_je';

  const SUBLISTS_TO_CHECK = ['item', 'expense'];

  function getSubsidiaryMap(subsidiaryId) {
    if (!subsidiaryId) return null;
    let result = null;

    search.create({
      type: MAP_RECORD,
      filters: [[MAP_SUBSIDIARY_FIELD, 'anyof', subsidiaryId]],
      columns: [MAP_AR_FIELD, MAP_AP_FIELD, MAP_CONFIRMED_FIELD]
    }).run().each((r) => {
      result = {
        arAccount: r.getValue(MAP_AR_FIELD),
        apAccount: r.getValue(MAP_AP_FIELD),
        confirmed: r.getValue(MAP_CONFIRMED_FIELD)
      };
      return false; // one row per subsidiary expected
    });

    return result;
  }

  function collectAllocationLines(bill, sourceMap, sourceSubsidiary) {
    const lines = [];

    SUBLISTS_TO_CHECK.forEach((sublistId) => {
      let lineCount;
      try {
        lineCount = bill.getLineCount({ sublistId });
      } catch (e) {
        return; // sublist not present on this form
      }

      for (let i = 0; i < lineCount; i++) {
        const targetSubsidiary = bill.getSublistValue({ sublistId, fieldId: TARGET_SUB_FIELD, line: i });
        if (!targetSubsidiary) continue;

        const targetMap = getSubsidiaryMap(targetSubsidiary);

        if (!sourceMap || !targetMap || !sourceMap.confirmed || !targetMap.confirmed) {
          log.audit({
            title: 'IC allocation skipped',
            details: 'Bill ' + bill.id + ', ' + sublistId + ' line ' + i +
              ': source or target subsidiary not confirmed for automated elimination. Left for manual entry.'
          });
          continue;
        }

        const expenseAccount = bill.getSublistValue({ sublistId, fieldId: TARGET_ACCT_FIELD, line: i }) ||
          bill.getSublistValue({ sublistId, fieldId: 'account', line: i });
        const amount = bill.getSublistValue({ sublistId, fieldId: TARGET_AMT_FIELD, line: i }) ||
          bill.getSublistValue({ sublistId, fieldId: 'amount', line: i });
        const memo = bill.getSublistValue({ sublistId, fieldId: MEMO_FIELD, line: i });

        if (!expenseAccount || !amount) {
          log.error({
            title: 'IC allocation line incomplete',
            details: 'Bill ' + bill.id + ', ' + sublistId + ' line ' + i + ': missing account or amount, skipped.'
          });
          continue;
        }

        lines.push({
          sourceSubsidiary,
          targetSubsidiary,
          sourceAr: sourceMap.arAccount,
          targetAp: targetMap.apAccount,
          expenseAccount,
          amount,
          memo
        });
      }
    });

    return lines;
  }

  function addLine(je, { account, subsidiary, debit, credit, memo }) {
    je.selectNewLine({ sublistId: 'line' });
    je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'account', value: account });
    je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'subsidiary', value: subsidiary });
    if (debit != null) je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'debit', value: debit });
    if (credit != null) je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'credit', value: credit });
    je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'eliminate', value: true });
    if (memo) je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'memo', value: memo });
    je.commitLine({ sublistId: 'line' });
  }

  function createAicje(allocationLines) {
    const je = record.create({
      type: record.Type.ADV_INTER_COMPANY_JOURNAL_ENTRY,
      isDynamic: true
    });

    allocationLines.forEach((l) => {
      addLine(je, { account: l.sourceAr, subsidiary: l.sourceSubsidiary, debit: l.amount, memo: l.memo });
      addLine(je, { account: l.expenseAccount, subsidiary: l.sourceSubsidiary, credit: l.amount });
      addLine(je, { account: l.expenseAccount, subsidiary: l.targetSubsidiary, debit: l.amount, memo: l.memo });
      addLine(je, { account: l.targetAp, subsidiary: l.targetSubsidiary, credit: l.amount });
    });

    return je.save();
  }

  function afterSubmit(context) {
    if (context.type !== context.UserEventType.CREATE && context.type !== context.UserEventType.EDIT) {
      return;
    }

    const bill = context.newRecord;

    try {
      const sourceSubsidiary = bill.getValue('subsidiary');
      const sourceMap = getSubsidiaryMap(sourceSubsidiary);
      const allocationLines = collectAllocationLines(bill, sourceMap, sourceSubsidiary);

      if (allocationLines.length === 0) return;

      const jeId = createAicje(allocationLines);

      record.submitFields({
        type: bill.type,
        id: bill.id,
        values: { [RELATED_JE_FIELD]: jeId }
      });

      log.audit({ title: 'IC AICJE created', details: 'JE ' + jeId + ' generated from bill ' + bill.id });

    } catch (e) {
      // Never let a failure here block the bill save. Log it and move on —
      // the bill still saves; the allocation just needs to be entered manually.
      log.error({ title: 'IC allocation failed', details: e });
    }
  }

  return { afterSubmit };
});
