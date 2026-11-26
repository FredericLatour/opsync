import { expect, it } from "bun:test";
import { findLatestBackup } from "../src/db/restorer";
import { S3Storage } from "../src/storage";

it("follows every S3 listing page before choosing the latest backup", async () => {
    const tokens: Array<string | null> = [];
    const server = Bun.serve({
        port: 0, hostname: "127.0.0.1",
        fetch(request) {
            const token = new URL(request.url).searchParams.get("continuation-token");
            tokens.push(token);
            return new Response(`<?xml version="1.0"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>fixture</Name><Prefix>scope/daily/</Prefix><KeyCount>1</KeyCount><MaxKeys>1</MaxKeys><IsTruncated>${!token}</IsTruncated>${token ? "" : "<NextContinuationToken>page2</NextContinuationToken>"}<Contents><Key>scope/daily/app_2026_10_${token ? "28" : "27"}_00_00_00.sql</Key><Size>1</Size><LastModified>2026-10-28T00:00:00Z</LastModified><ETag>"fixture"</ETag><StorageClass>STANDARD</StorageClass></Contents></ListBucketResult>`, { headers: { "Content-Type": "application/xml" } });
        },
    });
    try {
        const storage = new S3Storage({ accessKeyId: "fixture", secretAccessKey: "fixture", endpoint: server.url.toString(), region: "us-east-1", bucket: "fixture" }, "scope");
        expect(await findLatestBackup(storage, "daily", "app_")).toBe("daily/app_2026_10_28_00_00_00.sql");
        expect(tokens).toEqual([null, "page2"]);
    } finally { server.stop(true); }
});

it("propagates listing errors instead of pretending backups are absent", async () => {
    await expect(findLatestBackup({ list: async () => { throw new Error("Access denied"); }, get: async () => new Uint8Array(), put: async () => {}, delete: async () => {}, mkdir: async () => {} })).rejects.toThrow("Access denied");
});
