/**
 * NS EZ Interco Dist - vendor bill user event.
 *
 * After a bill saves, any Expense line with a target subsidiary gets moved to
 * that subsidiary through one Advanced Intercompany Journal Entry:
 *
 *   source sub: DR Interco AR (due from target)   CR original expense account
 *   target sub: DR expense account                CR Interco AP (due to source)
 *
 * Only the Interco AR/AP lines are marked Eliminate. The expense lines net to
 * zero in consolidation on their own.
 *
 * Pairs where either subsidiary isn't marked Elimination Confirmed in
 * customrecord_ic_subsidiary_map are skipped and left for manual entry.
 * A bill that already has a related JE is not processed again on edit.
 *
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/log', 'N/search'], (record, log, search) => {

  const AICJE_TYPE = 'advintercompanyjournalentry';

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

  // Item lines post to the item's own account (expense, asset or COGS), which
  // isn't on the bill line, so there's no safe account to credit. Expense
  // lines only for now.
  const SUPPORTED_SUBLIST = 'expense';
  const UNSUPPORTED_SUBLISTS = ['item'];

  function isChecked(value) {
    return value === true || value === 'T';
  }

  function getSubsidiaryMap(subsidiaryId, cache) {
    if (!subsidiaryId) return null;
    if (cache[subsidiaryId] !== undefined) return cache[subsidiaryId];

    let result = null;
    search.create({
      type: MAP_RECORD,
      filters: [[MAP_SUBSIDIARY_FIELD, 'anyof', subsidiaryId]],
      columns: [MAP_AR_FIELD, MAP_AP_FIELD, MAP_CONFIRMED_FIELD]
    }).run().each((r) => {
      result = {
        arAccount: r.getValue(MAP_AR_FIELD),
        apAccount: r.getValue(MAP_AP_FIELD),
        confirmed: isChecked(r.getValue(MAP_CONFIRMED_FIELD))
      };
      return false; // one row per subsidiary
    });

    cache[subsidiaryId] = result;
    return result;
  }

  function lineCount(bill, sublistId) {
    try {
      return bill.getLineCount({ sublistId });
    } catch (e) {
      return 0; // sublist not on this form
    }
  }

  function warnUnsupportedLines(bill) {
    UNSUPPORTED_SUBLISTS.forEach((sublistId) => {
      for (let i = 0; i < lineCount(bill, sublistId); i++) {
        if (bill.getSublistValue({ sublistId, fieldId: TARGET_SUB_FIELD, line: i })) {
          log.audit({
            title: 'IC allocation skipped',
            details: `Bill ${bill.id}, ${sublistId} line ${i + 1}: item lines aren't supported yet. Enter this one manually.`
          });
        }
      }
    });
  }

  function collectAllocationLines(bill, sourceSubsidiary, cache) {
    const sublistId = SUPPORTED_SUBLIST;
    const sourceMap = getSubsidiaryMap(sourceSubsidiary, cache);
    const lines = [];

    for (let i = 0; i < lineCount(bill, sublistId); i++) {
      const get = (fieldId) => bill.getSublistValue({ sublistId, fieldId, line: i });
      const where = `Bill ${bill.id}, ${sublistId} line ${i + 1}`;

      const targetSubsidiary = get(TARGET_SUB_FIELD);
      if (!targetSubsidiary) continue;

      if (String(targetSubsidiary) === String(sourceSubsidiary)) {
        log.audit({ title: 'IC allocation skipped', details: `${where}: target is the bill's own subsidiary.` });
        continue;
      }

      const targetMap = getSubsidiaryMap(targetSubsidiary, cache);
      if (!sourceMap || !targetMap || !sourceMap.confirmed || !targetMap.confirmed) {
        log.audit({
          title: 'IC allocation skipped',
          details: `${where}: source or target subsidiary isn't confirmed for elimination. Left for manual entry.`
        });
        continue;
      }
      if (!sourceMap.arAccount || !targetMap.apAccount) {
        log.error({ title: 'IC allocation skipped', details: `${where}: mapping record is missing an Interco AR or AP account.` });
        continue;
      }

      const sourceAccount = get('account');
      const targetAccount = get(TARGET_ACCT_FIELD) || sourceAccount;
      const lineAmount = Number(get('amount')) || 0;
      const amount = Number(get(TARGET_AMT_FIELD)) || lineAmount;

      if (!sourceAccount || !(amount > 0)) {
        log.error({ title: 'IC allocation skipped', details: `${where}: missing account or amount.` });
        continue;
      }
      if (amount > lineAmount) {
        log.error({
          title: 'IC allocation skipped',
          details: `${where}: allocation ${amount} is more than the line amount ${lineAmount}.`
        });
        continue;
      }

      lines.push({
        targetSubsidiary,
        sourceAr: sourceMap.arAccount,
        targetAp: targetMap.apAccount,
        sourceAccount,
        targetAccount,
        amount,
        memo: get(MEMO_FIELD) || ''
      });
    }

    return lines;
  }

  function addLine(je, { subsidiary, account, debit, credit, memo, eliminate }) {
    je.selectNewLine({ sublistId: 'line' });
    // Subsidiary first: the account list is filtered by it.
    je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'linesubsidiary', value: subsidiary });
    je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'account', value: account });
    if (debit != null) je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'debit', value: debit });
    if (credit != null) je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'credit', value: credit });
    if (eliminate) je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'eliminate', value: true });
    if (memo) je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'memo', value: memo });
    je.commitLine({ sublistId: 'line' });
  }

  function createAicje(bill, sourceSubsidiary, allocationLines) {
    const je = record.create({ type: AICJE_TYPE, isDynamic: true });
    je.setValue({ fieldId: 'subsidiary', value: sourceSubsidiary });
    const trandate = bill.getValue('trandate');
    if (trandate) je.setValue({ fieldId: 'trandate', value: trandate });
    je.setValue({ fieldId: 'memo', value: `IC allocation from vendor bill ${bill.id}` });

    allocationLines.forEach((l) => {
      addLine(je, { subsidiary: sourceSubsidiary, account: l.sourceAr, debit: l.amount, memo: l.memo, eliminate: true });
      addLine(je, { subsidiary: sourceSubsidiary, account: l.sourceAccount, credit: l.amount, memo: l.memo });
      addLine(je, { subsidiary: l.targetSubsidiary, account: l.targetAccount, debit: l.amount, memo: l.memo });
      addLine(je, { subsidiary: l.targetSubsidiary, account: l.targetAp, credit: l.amount, memo: l.memo, eliminate: true });
    });

    return je.save();
  }

  function afterSubmit(context) {
    const types = context.UserEventType;
    if (context.type !== types.CREATE && context.type !== types.EDIT) return;

    const bill = context.newRecord;

    try {
      // A copied bill carries the old JE id, so only trust it on edit.
      const existingJe = bill.getValue(RELATED_JE_FIELD);
      if (context.type === types.EDIT && existingJe) {
        log.audit({
          title: 'IC allocation not regenerated',
          details: `Bill ${bill.id} already has JE ${existingJe}. If the split changed, adjust that JE by hand.`
        });
        return;
      }

      warnUnsupportedLines(bill);

      const sourceSubsidiary = bill.getValue('subsidiary');
      const allocationLines = collectAllocationLines(bill, sourceSubsidiary, {});
      if (allocationLines.length === 0) {
        if (existingJe) {
          record.submitFields({ type: bill.type, id: bill.id, values: { [RELATED_JE_FIELD]: '' } });
        }
        return;
      }

      const jeId = createAicje(bill, sourceSubsidiary, allocationLines);
      record.submitFields({ type: bill.type, id: bill.id, values: { [RELATED_JE_FIELD]: jeId } });
      log.audit({ title: 'IC AICJE created', details: `JE ${jeId} from bill ${bill.id}` });

    } catch (e) {
      // The bill is already saved. Log it and let the allocation be entered by hand.
      log.error({ title: 'IC allocation failed', details: e });
    }
  }

  return { afterSubmit };
});
