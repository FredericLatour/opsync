import { describe, expect, it } from "bun:test";
import { createDefinerStripTransform } from "../src/db/definer-filter";
import { buildPrefix, stripDefiners } from "../src/db/dumper";

async function streamStrip(bytes: Uint8Array, chunkSize: number): Promise<Uint8Array> {
    const source = new ReadableStream<Uint8Array>({
        start(controller) {
            for (let i = 0; i < bytes.length; i += chunkSize) {
                controller.enqueue(bytes.subarray(i, i + chunkSize));
            }
            controller.close();
        },
    });
    return new Uint8Array(await new Response(source.pipeThrough(createDefinerStripTransform())).arrayBuffer());
}

describe("buildPrefix", () => {
    it("uses explicit filePrefix when provided", () => {
        const prefix = buildPrefix({ filePrefix: "custom_backup", database: "mydb" });
        expect(prefix).toBe("custom_backup_");
    });

    it("does not double-append trailing underscore when filePrefix already has one", () => {
        const prefix = buildPrefix({ filePrefix: "custom_backup_", database: "mydb" });
        expect(prefix).toBe("custom_backup_");
    });

    it("uses explicit name override when provided", () => {
        const prefix = buildPrefix({ name: "custom_backup", database: "mydb" });
        expect(prefix).toBe("custom_backup_");
    });

    it("uses tables when provided and no name override", () => {
        const prefix = buildPrefix({ tables: ["users", "orders"], database: "mydb" });
        expect(prefix).toBe("users_orders_");
    });

    it("falls back to database name", () => {
        const prefix = buildPrefix({ database: "mydb" });
        expect(prefix).toBe("mydb_");
    });
});

describe("stripDefiners", () => {
    it("preserves view definitions containing count(*) and removes DEFINER", () => {
        const sql =
            "CREATE ALGORITHM=UNDEFINED DEFINER=`dbuser`@`%` SQL SECURITY DEFINER VIEW `v_profiles` AS select count(*) AS profile_count FROM profiles WHERE 1=1;";
        const cleaned = stripDefiners(sql);
        expect(cleaned).toBe(
            "CREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `v_profiles` AS select count(*) AS profile_count FROM profiles WHERE 1=1;",
        );
        expect(cleaned).not.toContain("DEFINER=");
    });

    it("removes DEFINER from procedures, functions, triggers, and comments", () => {
        const sql = [
            "CREATE DEFINER=`root`@`localhost` PROCEDURE `my_proc`() BEGIN SELECT * FROM t; END;",
            "CREATE DEFINER=`root`@`localhost` FUNCTION `my_fn`() RETURNS INT RETURN 1;",
            "CREATE DEFINER=CURRENT_USER() VIEW `my_view` AS SELECT 1;",
            "/*!50013 DEFINER=`root`@`localhost` SQL SECURITY DEFINER */",
            "/*!50003 CREATE DEFINER=`root`@`%` TRIGGER `my_trig` BEFORE INSERT ON `t` FOR EACH ROW BEGIN END */",
        ].join("\n");
        const cleaned = stripDefiners(sql);
        expect(cleaned).toContain("CREATE PROCEDURE `my_proc`()");
        expect(cleaned).toContain("CREATE FUNCTION `my_fn`()");
        expect(cleaned).toContain("CREATE VIEW `my_view` AS SELECT 1;");
        expect(cleaned).toContain("/*!50003 CREATE TRIGGER `my_trig` BEFORE INSERT ON `t` FOR EACH ROW BEGIN END */");
        expect(cleaned).not.toContain("DEFINER");
    });

    it("preserves raw non-UTF-8 binary bytes when stripping DEFINER clauses from Uint8Array dumps", () => {
        const enc = new TextEncoder();
        const rawBinaryHashA = new Uint8Array([0x80, 0xff, 0xfe, 0xc3, 0x28, 0xed, 0xa0, 0x80]);
        const rawBinaryHashB = new Uint8Array([0x91, 0xfe, 0xff, 0xe2, 0x28, 0xa1, 0x81, 0x82]);

        const beforeDefiner = enc.encode("INSERT INTO `query` VALUES ('");
        const middleA = enc.encode("', 'row1'), ('");
        const middleB = enc.encode(
            "', 'row2');\n/*!50013 DEFINER=`root`@`localhost` SQL SECURITY DEFINER */\nCREATE DEFINER=`dbuser`@`%` VIEW `v` AS SELECT 1;\n",
        );

        const input = Buffer.concat([beforeDefiner, rawBinaryHashA, middleA, rawBinaryHashB, middleB]);
        const cleaned = stripDefiners(new Uint8Array(input));

        const expected = Buffer.concat([
            beforeDefiner,
            rawBinaryHashA,
            middleA,
            rawBinaryHashB,
            enc.encode("', 'row2');\n\nCREATE VIEW `v` AS SELECT 1;\n"),
        ]);

        expect(Buffer.from(cleaned).equals(expected)).toBe(true);
        expect(Buffer.from(cleaned).includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false);
    });

    it("produces identical output across 1-byte and 7-byte streaming chunks", async () => {
        const enc = new TextEncoder();
        const binary = new Uint8Array([0x80, 0xff, 0xfe, 0xc3, 0x28]);
        const input = Buffer.concat([
            enc.encode("INSERT INTO `t` VALUES ('"),
            binary,
            enc.encode("', 'it\\'s DEFINER=foo@bar', 'a''b DEFINER=`x`@`y`');\n"),
            enc.encode("-- DEFINER=root@localhost\n# DEFINER=root@localhost\n/* DEFINER=root@localhost */\n"),
            enc.encode("/*!50013 DEFINER=`root`@`localhost` SQL SECURITY DEFINER */\n"),
            enc.encode("/*!50003 CREATE DEFINER=`root`@`%` TRIGGER `tr` BEFORE INSERT ON `t` FOR EACH ROW BEGIN END */\n"),
            enc.encode("CREATE ALGORITHM=UNDEFINED DEFINER=`dbuser`@`%` SQL SECURITY DEFINER VIEW `v` AS SELECT count(*) FROM `t`;\n"),
        ]);

        const expected = stripDefiners(new Uint8Array(input));
        for (const chunkSize of [1, 3, 7, 19]) {
            const streamed = await streamStrip(new Uint8Array(input), chunkSize);
            expect(Buffer.from(streamed).equals(Buffer.from(expected))).toBe(true);
        }
    });
});

describe("backup data integrity", () => {
    it("preserves DEFINER text inside row data, escaped strings and comments", () => {
        const sql =
            "INSERT INTO logs VALUES ('hello DEFINER=`root`@`%` world', 'it\\'s DEFINER=foo@bar');\n-- DEFINER=root@localhost\n/* DEFINER=root@localhost */";
        expect(stripDefiners(sql)).toBe(sql);
    });
    it("normalizes comma-separated tables in prefixes and rejects escaping output paths", () => {
        expect(buildPrefix({ tables: ["users,orders"], database: "app" })).toBe("users_orders_");
        expect(() => buildPrefix({ filePrefix: "../../private", database: "app" })).toThrow("filename");
    });
});
