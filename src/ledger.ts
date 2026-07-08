import type { JournalInput, LedgerLineInput } from "./domain";

type Tx = unknown;

export interface LedgerRepository {
  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
  insertJournal(tx: Tx, journal: Omit<JournalInput, "lines">): Promise<{ id: string }>;
  insertLedgerLines(tx: Tx, journalEntryId: string, lines: LedgerLineInput[]): Promise<void>;
  findJournalByIdempotencyKey(tx: Tx, idempotencyKey: string): Promise<{ id: string } | undefined>;
  getActorAccountId(tx: Tx, userId: string, currency: string): Promise<string>;
  getPlatformAccountId(tx: Tx, kind: "MASTER_CASH" | "MASTER_FX_CLEARING" | "MASTER_FEE_REVENUE", currency: string): Promise<string>;
  getJournalLines(tx: Tx, journalEntryId: string): Promise<LedgerLineInput[]>;
}

export class LedgerService {
  constructor(private readonly repo: LedgerRepository) {}

  async post(journal: JournalInput): Promise<string> {
    return this.repo.transaction((tx) => this.postInTransaction(tx, journal));
  }

  async postInTransaction(tx: Tx, journal: JournalInput): Promise<string> {
    assertBalanced(journal.lines);

    const existing = await this.repo.findJournalByIdempotencyKey(tx, journal.idempotencyKey);
    if (existing) return existing.id;

    const { lines, ...header } = journal;
    const entry = await this.repo.insertJournal(tx, header);
    await this.repo.insertLedgerLines(tx, entry.id, lines);
    return entry.id;
  }

  async reverse(params: {
    originalJournalEntryId: string;
    sourceType: "ORDER_VOID" | "TRANSFER_REVERSAL";
    sourceId: string;
    idempotencyKey: string;
    description: string;
    createdByUserId?: string;
  }): Promise<string> {
    return this.repo.transaction((tx) => this.reverseInTransaction(tx, params));
  }

  async reverseInTransaction(tx: Tx, params: {
    originalJournalEntryId: string;
    sourceType: "ORDER_VOID" | "TRANSFER_REVERSAL";
    sourceId: string;
    idempotencyKey: string;
    description: string;
    createdByUserId?: string;
  }): Promise<string> {
    const existing = await this.repo.findJournalByIdempotencyKey(tx, params.idempotencyKey);
    if (existing) return existing.id;

    const originalLines = await this.repo.getJournalLines(tx, params.originalJournalEntryId);
    const reversingLines = originalLines.map((line) => ({
      ...line,
      direction: line.direction === "DEBIT" ? "CREDIT" as const : "DEBIT" as const,
      memo: `Reversal: ${line.memo ?? ""}`.trim(),
    }));
    assertBalanced(reversingLines);

    const entry = await this.repo.insertJournal(tx, {
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      idempotencyKey: params.idempotencyKey,
      description: params.description,
      reversedJournalEntryId: params.originalJournalEntryId,
      ...(params.createdByUserId ? { createdByUserId: params.createdByUserId } : {}),
    });
    await this.repo.insertLedgerLines(tx, entry.id, reversingLines);
    return entry.id;
  }
}

export function assertBalanced(lines: LedgerLineInput[]): void {
  if (lines.length < 2) throw new Error("a journal entry needs at least two ledger lines");

  const totals = new Map<string, bigint>();
  for (const line of lines) {
    if (line.amountMinor <= 0n) throw new Error("ledger line amount must be positive");
    const signed = line.direction === "DEBIT" ? line.amountMinor : -line.amountMinor;
    totals.set(line.currency, (totals.get(line.currency) ?? 0n) + signed);
  }

  for (const [currency, total] of totals) {
    if (total !== 0n) throw new Error(`journal entry is not balanced for ${currency}`);
  }
}
