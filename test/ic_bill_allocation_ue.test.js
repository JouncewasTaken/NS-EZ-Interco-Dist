// Runs the user event against fake N/record, N/search and N/log modules.
// It checks the script's own logic (what it posts and when), not NetSuite.
//   node --test

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const SCRIPT = path.join(__dirname, '..', 'src', 'FileCabinet', 'SuiteScripts', 'ic_bill_allocation_ue.js');

// subsidiary id -> mapping row
const MAPS = {
  1: { custrecord_ic_ar_account: 'AR1', custrecord_ic_ap_account: 'AP1', custrecord_ic_elim_confirmed: true },
  2: { custrecord_ic_ar_account: 'AR2', custrecord_ic_ap_account: 'AP2', custrecord_ic_elim_confirmed: true },
  3: { custrecord_ic_ar_account: 'AR3', custrecord_ic_ap_account: 'AP3', custrecord_ic_elim_confirmed: false }
};

function load({ saveThrows = false } = {}) {
  const calls = { created: [], submitted: [], logs: [] };

  const record = {
    create({ type, isDynamic }) {
      const je = { type, isDynamic, body: {}, lines: [], current: null };
      je.setValue = ({ fieldId, value }) => { je.body[fieldId] = value; };
      je.selectNewLine = () => { je.current = { _order: [] }; };
      je.setCurrentSublistValue = ({ fieldId, value }) => { je.current[fieldId] = value; je.current._order.push(fieldId); };
      je.commitLine = () => { je.lines.push(je.current); je.current = null; };
      je.save = () => { if (saveThrows) throw new Error('save failed'); return 999; };
      calls.created.push(je);
      return je;
    },
    submitFields(args) { calls.submitted.push(args); }
  };

  const search = {
    create({ filters }) {
      const subId = filters[0][2];
      const row = MAPS[subId];
      return {
        run: () => ({
          each(cb) { if (row) cb({ getValue: (f) => row[f] }); }
        })
      };
    }
  };

  const log = {
    audit: (e) => calls.logs.push(['audit', e.title, e.details]),
    error: (e) => calls.logs.push(['error', e.title, String(e.details)])
  };

  let factory;
  vm.runInNewContext(fs.readFileSync(SCRIPT, 'utf8'), {
    define: (deps, fn) => { factory = fn; }
  });
  const ue = factory(record, log, search);
  return { ue, calls };
}

function bill({ subsidiary = 1, relatedJe = '', expense = [], item = [] } = {}) {
  const sublists = { expense, item };
  const body = { subsidiary, trandate: '2026-10-01', custbody_ic_related_je: relatedJe };
  return {
    id: 500,
    type: 'vendorbill',
    getValue: (f) => body[typeof f === 'string' ? f : f.fieldId],
    getLineCount: ({ sublistId }) => sublists[sublistId].length,
    getSublistValue: ({ sublistId, fieldId, line }) => sublists[sublistId][line][fieldId]
  };
}

// Objects built inside the vm context have a different Object prototype.
const plain = (x) => JSON.parse(JSON.stringify(x));

const TYPES = { CREATE: 'create', EDIT: 'edit', DELETE: 'delete' };
const ctx = (type, newRecord) => ({ type, newRecord, UserEventType: TYPES });

function totals(lines, sub) {
  const own = lines.filter((l) => l.linesubsidiary === sub);
  const sum = (k) => own.reduce((s, l) => s + (l[k] || 0), 0);
  return { debit: sum('debit'), credit: sum('credit') };
}

test('creates a balanced 4-line AICJE and links it to the bill', () => {
  const { ue, calls } = load();
  ue.afterSubmit(ctx('create', bill({
    expense: [{ account: 'EXP', amount: 100, custcol_ic_target_subsidiary: 2, custcol_ic_memo: 'rent split' }]
  })));

  assert.equal(calls.created.length, 1);
  const je = calls.created[0];
  assert.equal(je.type, 'advintercompanyjournalentry');
  assert.equal(je.body.subsidiary, 1);
  assert.equal(je.body.trandate, '2026-10-01');
  assert.equal(je.lines.length, 4);

  const [srcAr, srcExp, tgtExp, tgtAp] = je.lines;
  assert.deepEqual([srcAr.account, srcAr.debit, srcAr.linesubsidiary], ['AR1', 100, 1]);
  assert.deepEqual([srcExp.account, srcExp.credit, srcExp.linesubsidiary], ['EXP', 100, 1]);
  assert.deepEqual([tgtExp.account, tgtExp.debit, tgtExp.linesubsidiary], ['EXP', 100, 2]);
  assert.deepEqual([tgtAp.account, tgtAp.credit, tgtAp.linesubsidiary], ['AP2', 100, 2]);

  assert.deepEqual(totals(je.lines, 1), { debit: 100, credit: 100 });
  assert.deepEqual(totals(je.lines, 2), { debit: 100, credit: 100 });

  // only the intercompany lines are eliminated
  assert.deepEqual(je.lines.map((l) => Boolean(l.eliminate)), [true, false, false, true]);
  // subsidiary is set before account on every line
  je.lines.forEach((l) => assert.ok(l._order.indexOf('linesubsidiary') < l._order.indexOf('account')));

  assert.deepEqual(plain(calls.submitted), [{ type: 'vendorbill', id: 500, values: { custbody_ic_related_je: 999 } }]);
});

test('a different target account is debited on the target side only', () => {
  const { ue, calls } = load();
  ue.afterSubmit(ctx('create', bill({
    expense: [{ account: 'EXP', amount: 100, custcol_ic_target_subsidiary: 2, custcol_ic_target_account: 'EXP2' }]
  })));
  const [, srcExp, tgtExp] = calls.created[0].lines;
  assert.equal(srcExp.account, 'EXP');
  assert.equal(tgtExp.account, 'EXP2');
});

test('a partial target amount moves only that amount', () => {
  const { ue, calls } = load();
  ue.afterSubmit(ctx('create', bill({
    expense: [{ account: 'EXP', amount: 100, custcol_ic_target_subsidiary: 2, custcol_ic_target_amount: 40 }]
  })));
  assert.ok(calls.created[0].lines.every((l) => (l.debit || l.credit) === 40));
});

test('several lines go into one JE', () => {
  const { ue, calls } = load();
  ue.afterSubmit(ctx('create', bill({
    expense: [
      { account: 'EXP', amount: 100, custcol_ic_target_subsidiary: 2 },
      { account: 'EXP', amount: 50 },
      { account: 'EXP9', amount: 25, custcol_ic_target_subsidiary: 2 }
    ]
  })));
  assert.equal(calls.created.length, 1);
  assert.equal(calls.created[0].lines.length, 8);
});

test('editing a bill that already has a JE does not create another', () => {
  const { ue, calls } = load();
  ue.afterSubmit(ctx('edit', bill({
    relatedJe: 777,
    expense: [{ account: 'EXP', amount: 100, custcol_ic_target_subsidiary: 2 }]
  })));
  assert.equal(calls.created.length, 0);
  assert.equal(calls.submitted.length, 0);
});

test('a copied bill gets its own JE instead of keeping the old link', () => {
  const { ue, calls } = load();
  ue.afterSubmit(ctx('create', bill({
    relatedJe: 777,
    expense: [{ account: 'EXP', amount: 100, custcol_ic_target_subsidiary: 2 }]
  })));
  assert.equal(calls.created.length, 1);
  assert.equal(calls.submitted[0].values.custbody_ic_related_je, 999);
});

test('a copied bill with no allocation lines drops the old link', () => {
  const { ue, calls } = load();
  ue.afterSubmit(ctx('create', bill({ relatedJe: 777, expense: [{ account: 'EXP', amount: 100 }] })));
  assert.equal(calls.created.length, 0);
  assert.deepEqual(plain(calls.submitted[0].values), { custbody_ic_related_je: '' });
});

test('unconfirmed or unmapped subsidiaries are skipped', () => {
  for (const target of [3, 42]) {
    const { ue, calls } = load();
    ue.afterSubmit(ctx('create', bill({
      expense: [{ account: 'EXP', amount: 100, custcol_ic_target_subsidiary: target }]
    })));
    assert.equal(calls.created.length, 0, `target ${target}`);
  }
});

test('allocating more than the line amount is refused', () => {
  const { ue, calls } = load();
  ue.afterSubmit(ctx('create', bill({
    expense: [{ account: 'EXP', amount: 100, custcol_ic_target_subsidiary: 2, custcol_ic_target_amount: 150 }]
  })));
  assert.equal(calls.created.length, 0);
  assert.ok(calls.logs.some(([lvl, , d]) => lvl === 'error' && d.includes('more than the line amount')));
});

test('target equal to the bill subsidiary is skipped', () => {
  const { ue, calls } = load();
  ue.afterSubmit(ctx('create', bill({
    expense: [{ account: 'EXP', amount: 100, custcol_ic_target_subsidiary: 1 }]
  })));
  assert.equal(calls.created.length, 0);
});

test('item lines are logged and left alone', () => {
  const { ue, calls } = load();
  ue.afterSubmit(ctx('create', bill({
    item: [{ item: 10, amount: 100, custcol_ic_target_subsidiary: 2 }]
  })));
  assert.equal(calls.created.length, 0);
  assert.ok(calls.logs.some(([, , d]) => d.includes("item lines aren't supported")));
});

test('delete and other event types do nothing', () => {
  const { ue, calls } = load();
  ue.afterSubmit(ctx('delete', bill({
    expense: [{ account: 'EXP', amount: 100, custcol_ic_target_subsidiary: 2 }]
  })));
  assert.equal(calls.created.length, 0);
});

test('a failed JE save is logged, not thrown', () => {
  const { ue, calls } = load({ saveThrows: true });
  assert.doesNotThrow(() => ue.afterSubmit(ctx('create', bill({
    expense: [{ account: 'EXP', amount: 100, custcol_ic_target_subsidiary: 2 }]
  }))));
  assert.equal(calls.submitted.length, 0);
  assert.ok(calls.logs.some(([lvl, t]) => lvl === 'error' && t === 'IC allocation failed'));
});
