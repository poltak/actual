// Adds the schema for a currency on each account.
//
// - accounts.currency: ISO code. NULL means the base currency of the budget.
// - transactions.native_amount: the amount in the currency of the account.
//   NULL means the same as `amount`, which stays in the base currency.
// - transactions.amount_locked: 1 when a person set `amount` by hand.
// - exchange_rates: one row for a currency pair and a date. The id is
//   `FROM:TO:DATE`, so two devices that store the same rate write one row.
//
// Each step checks what is there first. The migration is then safe to run
// on a database that already has part of this schema.

function hasColumn(db, table, column) {
  const columns = db.runQuery(`PRAGMA table_info(${table})`, [], true);
  return columns.some(info => info.name === column);
}

export default async function runMigration(db) {
  db.transaction(() => {
    if (!hasColumn(db, 'accounts', 'currency')) {
      db.execQuery('ALTER TABLE accounts ADD COLUMN currency TEXT;');
    }

    if (!hasColumn(db, 'transactions', 'native_amount')) {
      db.execQuery(
        'ALTER TABLE transactions ADD COLUMN native_amount INTEGER;',
      );
    }

    if (!hasColumn(db, 'transactions', 'amount_locked')) {
      db.execQuery(
        'ALTER TABLE transactions ADD COLUMN amount_locked INTEGER;',
      );
    }

    db.execQuery(`
      CREATE TABLE IF NOT EXISTS exchange_rates
        (id TEXT PRIMARY KEY,
         from_currency TEXT,
         to_currency TEXT,
         date INTEGER,
         rate REAL,
         source TEXT,
         tombstone INTEGER DEFAULT 0);

      CREATE INDEX IF NOT EXISTS exchange_rates_pair_date
        ON exchange_rates(from_currency, to_currency, date);
    `);
  });
}
