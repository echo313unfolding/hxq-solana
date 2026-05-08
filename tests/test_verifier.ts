/**
 * Tests for the offline receipt verifier.
 * Does not require Solana validator.
 */

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

// Import verifier — need to use require since the module uses import/export
// We compile it via ts-mocha with the right config
const { verifyReceipt } = require("../scripts/verify_receipt");

const RECEIPTS_DIR = path.resolve(__dirname, "..", "receipts");
const LIFECYCLE_RECEIPT = path.join(RECEIPTS_DIR, "hxq_solana_lifecycle_demo_20260508.json");
const DOMAIN_RECEIPT = path.join(RECEIPTS_DIR, "domain_fixture_demos_20260508.json");

describe("Receipt Verifier", () => {
  describe("lifecycle receipt", () => {
    it("passes on valid lifecycle receipt", () => {
      const { checks, allPass } = verifyReceipt(LIFECYCLE_RECEIPT);
      expect(allPass).to.be.true;
      const failedChecks = checks.filter((c: any) => !c.pass);
      expect(failedChecks).to.have.lengthOf(0);
    });
  });

  describe("domain fixture receipt", () => {
    it("passes on valid domain fixture receipt", () => {
      const { checks, allPass } = verifyReceipt(DOMAIN_RECEIPT);
      expect(allPass).to.be.true;
      const failedChecks = checks.filter((c: any) => !c.pass);
      expect(failedChecks).to.have.lengthOf(0);
    });
  });

  describe("corrupted receipt", () => {
    const tmpPath = path.join(RECEIPTS_DIR, "_test_corrupted.json");

    afterEach(() => {
      try { fs.unlinkSync(tmpPath); } catch (e) {}
    });

    it("fails on corrupted lifecycle receipt (wrong program_id)", () => {
      const original = JSON.parse(fs.readFileSync(LIFECYCLE_RECEIPT, "utf-8"));
      original.program_id = "WRONG_PROGRAM_ID";
      fs.writeFileSync(tmpPath, JSON.stringify(original));

      const { allPass } = verifyReceipt(tmpPath);
      expect(allPass).to.be.false;
    });

    it("fails on corrupted lifecycle receipt (all_pass = false)", () => {
      const original = JSON.parse(fs.readFileSync(LIFECYCLE_RECEIPT, "utf-8"));
      original.all_pass = false;
      fs.writeFileSync(tmpPath, JSON.stringify(original));

      const { allPass } = verifyReceipt(tmpPath);
      expect(allPass).to.be.false;
    });

    it("fails on corrupted lifecycle receipt (bad content_hash)", () => {
      const original = JSON.parse(fs.readFileSync(LIFECYCLE_RECEIPT, "utf-8"));
      original.content_hash = "not-a-hex-hash";
      fs.writeFileSync(tmpPath, JSON.stringify(original));

      const { allPass } = verifyReceipt(tmpPath);
      expect(allPass).to.be.false;
    });

    it("fails on corrupted lifecycle receipt (missing steps)", () => {
      const original = JSON.parse(fs.readFileSync(LIFECYCLE_RECEIPT, "utf-8"));
      original.steps = [];
      fs.writeFileSync(tmpPath, JSON.stringify(original));

      const { allPass } = verifyReceipt(tmpPath);
      expect(allPass).to.be.false;
    });

    it("fails on corrupted domain receipt (missing domain)", () => {
      const original = JSON.parse(fs.readFileSync(DOMAIN_RECEIPT, "utf-8"));
      original.domains = original.domains.slice(0, 1);
      original.domains_tested = 1;
      fs.writeFileSync(tmpPath, JSON.stringify(original));

      const { allPass } = verifyReceipt(tmpPath);
      expect(allPass).to.be.false;
    });

    it("fails on corrupted domain receipt (zeroed tx signature)", () => {
      const original = JSON.parse(fs.readFileSync(DOMAIN_RECEIPT, "utf-8"));
      original.domains[0].register_tx = "";
      fs.writeFileSync(tmpPath, JSON.stringify(original));

      const { allPass } = verifyReceipt(tmpPath);
      expect(allPass).to.be.false;
    });

    it("fails on unknown receipt type", () => {
      fs.writeFileSync(tmpPath, JSON.stringify({ demo: "UNKNOWN_TYPE" }));

      const { allPass } = verifyReceipt(tmpPath);
      expect(allPass).to.be.false;
    });
  });
});
