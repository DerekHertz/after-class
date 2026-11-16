/** SQL shared by the migration files. */
export const appendOnly = (table: string, rule?: string) => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
BEGIN SELECT RAISE(ABORT, '${rule ? `${rule}: ` : ""}${table} is append-only'); END;`;
