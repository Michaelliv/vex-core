import { describe, test, expect, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
setDefaultTimeout(15_000);
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import { duckdbAdapter } from "../src/adapters/duckdb.js";
import type { StorageAdapter } from "../src/core/storage.js";
import type { TableSchema } from "../src/core/types.js";

const schema: TableSchema = {
  columns: {
    name: { type: "string" },
    age: { type: "number" },
    active: { type: "boolean", optional: true },
    meta: { type: "json", optional: true },
  },
};

const indexedSchema: TableSchema = {
  columns: {
    category: { type: "string", index: true },
    value: { type: "number" },
  },
  indexes: [["idx_cat_val", ["category", "value"]]],
  unique: [["category", "value"]],
};

function adapterSuite(name: string, create: () => Promise<StorageAdapter>) {
  describe(name, () => {
    let adapter: StorageAdapter;

    beforeEach(async () => {
      adapter = await create();
      await adapter.ensureTable("users", schema);
    });

    afterEach(async () => {
      await adapter.close();
    });

    // --- insert / query ---

    test("insert returns id and row is queryable", async () => {
      const id = await adapter.insert("users", { name: "alice", age: 30 });
      expect(id).toBeString();
      expect(id.length).toBeGreaterThan(0);

      const row = await adapter.query("users").first<any>();
      expect(row).not.toBeNull();
      expect(row.name).toBe("alice");
      expect(row.age).toBe(30);
      expect(row._id).toBe(id);
    });

    test("insert with custom _id", async () => {
      const id = await adapter.insert("users", { _id: "custom-1", name: "bob", age: 25 });
      expect(id).toBe("custom-1");
      const row = await adapter.query("users").where("_id", "=", "custom-1").first<any>();
      expect(row.name).toBe("bob");
    });

    test("insert with boolean and json", async () => {
      await adapter.insert("users", { name: "carol", age: 28, active: true, meta: { role: "admin" } });
      const row = await adapter.query("users").first<any>();
      expect(row.active).toBe(true);
      expect(row.meta).toEqual({ role: "admin" });
    });

    // --- query builder ---

    test("where filters", async () => {
      await adapter.insert("users", { name: "alice", age: 30 });
      await adapter.insert("users", { name: "bob", age: 25 });
      await adapter.insert("users", { name: "carol", age: 35 });

      const young = await adapter.query("users").where("age", "<", 30).all<any>();
      expect(young).toHaveLength(1);
      expect(young[0].name).toBe("bob");

      const old = await adapter.query("users").where("age", ">=", 30).all<any>();
      expect(old).toHaveLength(2);
    });

    test("where with IN operator", async () => {
      await adapter.insert("users", { name: "alice", age: 30 });
      await adapter.insert("users", { name: "bob", age: 25 });
      await adapter.insert("users", { name: "carol", age: 35 });

      const result = await adapter.query("users").where("name", "IN", ["alice", "carol"]).all<any>();
      expect(result).toHaveLength(2);
    });

    test("chained where (AND)", async () => {
      await adapter.insert("users", { name: "alice", age: 30, active: true });
      await adapter.insert("users", { name: "bob", age: 30, active: false });

      const result = await adapter.query("users").where("age", "=", 30).where("active", "=", 1).all<any>();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("alice");
    });

    test("order asc/desc", async () => {
      await adapter.insert("users", { name: "bob", age: 25 });
      await adapter.insert("users", { name: "alice", age: 30 });
      await adapter.insert("users", { name: "carol", age: 20 });

      const asc = await adapter.query("users").order("age", "asc").all<any>();
      expect(asc.map((r: any) => r.name)).toEqual(["carol", "bob", "alice"]);

      const desc = await adapter.query("users").order("age", "desc").all<any>();
      expect(desc.map((r: any) => r.name)).toEqual(["alice", "bob", "carol"]);
    });

    test("limit and offset", async () => {
      for (let i = 0; i < 10; i++) {
        await adapter.insert("users", { name: `user-${i}`, age: i });
      }

      const page1 = await adapter.query("users").order("age").limit(3).all<any>();
      expect(page1).toHaveLength(3);
      expect(page1[0].age).toBe(0);

      const page2 = await adapter.query("users").order("age").limit(3).offset(3).all<any>();
      expect(page2).toHaveLength(3);
      expect(page2[0].age).toBe(3);
    });

    test("first returns null on empty", async () => {
      const row = await adapter.query("users").first();
      expect(row).toBeNull();
    });

    test("count", async () => {
      await adapter.insert("users", { name: "alice", age: 30 });
      await adapter.insert("users", { name: "bob", age: 25 });

      expect(await adapter.query("users").count()).toBe(2);
      expect(await adapter.query("users").where("age", ">", 28).count()).toBe(1);
    });

    test("query builder delete with filters", async () => {
      await adapter.insert("users", { name: "alice", age: 30 });
      await adapter.insert("users", { name: "bob", age: 25 });
      await adapter.insert("users", { name: "carol", age: 35 });

      await adapter.query("users").where("age", "<", 30).delete();

      const remaining = await adapter.query("users").all<any>();
      expect(remaining).toHaveLength(2);
      expect(remaining.every((r: any) => r.age >= 30)).toBe(true);
    });

    // --- update ---

    test("update modifies row", async () => {
      const id = await adapter.insert("users", { name: "alice", age: 30 });
      await adapter.update("users", id, { age: 31 });

      const row = await adapter.query("users").where("_id", "=", id).first<any>();
      expect(row.age).toBe(31);
      expect(row.name).toBe("alice");
    });

    // --- delete ---

    test("delete by id", async () => {
      const id = await adapter.insert("users", { name: "alice", age: 30 });
      const deleted = await adapter.delete("users", id);
      expect(deleted).toBe(true);

      const row = await adapter.query("users").where("_id", "=", id).first();
      expect(row).toBeNull();
    });

    test("delete nonexistent returns false", async () => {
      const deleted = await adapter.delete("users", "nope");
      expect(deleted).toBe(false);
    });

    // --- upsert ---

    test("upsert inserts when missing", async () => {
      await adapter.upsert("users", { name: "alice" }, { age: 30 });
      const row = await adapter.query("users").where("name", "=", "alice").first<any>();
      expect(row).not.toBeNull();
      expect(row.age).toBe(30);
    });

    test("upsert updates when existing", async () => {
      await adapter.insert("users", { name: "alice", age: 30 });
      await adapter.upsert("users", { name: "alice" }, { age: 31 });

      const rows = await adapter.query("users").where("name", "=", "alice").all<any>();
      expect(rows).toHaveLength(1);
      expect(rows[0].age).toBe(31);
    });

    // --- transaction ---

    test("transaction commits", async () => {
      await adapter.transaction(async () => {
        await adapter.insert("users", { name: "alice", age: 30 });
        await adapter.insert("users", { name: "bob", age: 25 });
      });

      expect(await adapter.query("users").count()).toBe(2);
    });

    test("transaction rolls back on error", async () => {
      try {
        await adapter.transaction(async () => {
          await adapter.insert("users", { name: "alice", age: 30 });
          throw new Error("boom");
        });
      } catch {}

      expect(await adapter.query("users").count()).toBe(0);
    });

    test("nested transaction joins outer (no BEGIN error)", async () => {
      await adapter.transaction(async () => {
        await adapter.insert("users", { name: "alice", age: 30 });
        // Nested transaction should piggyback on the outer one
        await adapter.transaction(async () => {
          await adapter.insert("users", { name: "bob", age: 25 });
        });
      });

      expect(await adapter.query("users").count()).toBe(2);
    });

    test("nested transaction error propagates and outer rolls back", async () => {
      try {
        await adapter.transaction(async () => {
          await adapter.insert("users", { name: "alice", age: 30 });
          await adapter.transaction(async () => {
            throw new Error("inner boom");
          });
        });
      } catch {}

      expect(await adapter.query("users").count()).toBe(0);
    });

    // --- rawQuery / rawExec ---

    test("rawQuery returns results", async () => {
      await adapter.insert("users", { name: "alice", age: 30 });
      const rows = await adapter.rawQuery<any>('SELECT name FROM "users"');
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe("alice");
    });

    test("rawExec runs statements", async () => {
      await adapter.insert("users", { name: "alice", age: 30 });
      await adapter.rawExec('DELETE FROM "users" WHERE name = ?', "alice");
      expect(await adapter.query("users").count()).toBe(0);
    });

    // --- bulkInsert ---

    test("bulkInsert inserts all rows", async () => {
      const rows = Array.from({ length: 100 }, (_, i) => ({ name: `user-${i}`, age: i }));
      await adapter.bulkInsert("users", rows);
      expect(await adapter.query("users").count()).toBe(100);
    });

    test("bulkInsert assigns unique ids", async () => {
      await adapter.bulkInsert("users", [
        { name: "alice", age: 30 },
        { name: "bob", age: 25 },
      ]);
      const ids = (await adapter.query("users").all<any>()).map((r: any) => r._id);
      expect(ids[0]).not.toBe(ids[1]);
    });

    test("bulkInsert empty is noop", async () => {
      await adapter.bulkInsert("users", []);
      expect(await adapter.query("users").count()).toBe(0);
    });

    // --- changedTables ---

    test("getChangedTables tracks mutations", async () => {
      adapter.getChangedTables(); // clear
      await adapter.insert("users", { name: "alice", age: 30 });
      const changed = adapter.getChangedTables();
      expect(changed).toContain("users");
    });

    test("getChangedTables clears after read", async () => {
      await adapter.insert("users", { name: "alice", age: 30 });
      adapter.getChangedTables();
      const second = adapter.getChangedTables();
      expect(second).toHaveLength(0);
    });

    // --- ensureTable idempotent ---

    test("ensureTable is idempotent", async () => {
      await adapter.ensureTable("users", schema);
      await adapter.ensureTable("users", schema);
      await adapter.insert("users", { name: "alice", age: 30 });
      expect(await adapter.query("users").count()).toBe(1);
    });

    // --- indexes / unique ---

    test("ensureTable with indexes", async () => {
      await adapter.ensureTable("items", indexedSchema);
      await adapter.insert("items", { category: "a", value: 1 });
      const row = await adapter.query("items").where("category", "=", "a").first<any>();
      expect(row.value).toBe(1);
    });
  });
}

adapterSuite("sqlite", async () => sqliteAdapter(":memory:"));
adapterSuite("duckdb", async () => duckdbAdapter(":memory:"));

// --- sqlite-specific ---

describe("sqlite-specific", () => {
  test("column migration adds new columns", () => {
    const adapter = sqliteAdapter(":memory:");
    adapter.ensureTable("t", { columns: { a: { type: "string" } } });
    adapter.ensureTable("t", {
      columns: { a: { type: "string" }, b: { type: "number" } },
    });
    // Should not throw — b was added
    adapter.close();
  });

  test("unique constraint prevents duplicates", async () => {
    const adapter = sqliteAdapter(":memory:");
    await adapter.ensureTable("items", indexedSchema);
    await adapter.insert("items", { category: "a", value: 1 });
    expect(async () => {
      await adapter.insert("items", { category: "a", value: 1 });
    }).toThrow();
    adapter.close();
  });
});

// --- duckdb-specific ---

describe("duckdb-specific", () => {
  test("primary key prevents duplicate _id", async () => {
    const adapter = await duckdbAdapter(":memory:");
    await adapter.ensureTable("users", schema);
    await adapter.insert("users", { _id: "dup", name: "alice", age: 30 });
    expect(async () => {
      await adapter.insert("users", { _id: "dup", name: "bob", age: 25 });
    }).toThrow();
    await adapter.close();
  });
});
