# Bank → Tally ledger rules

How TallyThis proposes a Tally ledger for each bank row, and why. Code: `suggestLedgerDetail` in `backend/api/src/services/tallyVoucherXml.ts`, party names in `counterpartyFrom` (`bankStatement.ts`), grouping in `ledgerSuggest.ts`.

## Order of decisions

1. **Remembered choice** for this client and party. Taken as chosen.
2. **Keyword rule.** Two kinds:
   - **Sure** (`source: "rule"`): taken as chosen. Example: "CREDIT INTEREST" → Interest Received.
   - **Suggested** (`source: "hint"`): a likely ledger that the CA must confirm, shown with a "Suggested" badge. Used when the narration alone cannot settle the treatment.
3. **AI pick** from the fixed ledger list for parties no rule placed (`source: "ai"`). Always needs confirmation. Never used in Incognito.
4. **Suspense** otherwise. Always needs a decision.

Nothing reaches the Tally file until every party is chosen or confirmed (or every one of its rows has its own ledger).

## Money coming back into an expense needs confirmation

When money comes **in** and the rule's ledger is an expense (Indirect Expenses or Purchase), the suggestion is never "sure". It could be a refund (reduce that expense), a reversal of a failed payment, or cashback (income). Only the CA can tell.

## Payment apps print their own name

"Google", "PhonePe" or "Paytm" in a narration usually says *how* money moved, not *what* it paid for. The handle says more.

| Handle seen on statements | Party name we give it | Treatment | Why |
| --- | --- | --- | --- |
| `goog-payments@axisbank` (money in) | Google payments | Cashback Received (Indirect Incomes), **suggested** | Google Pay credits cashback/rewards to the linked bank account ([Google Pay help](https://support.google.com/pay/india/answer/15970651?hl=en)); a refund of a Google purchase is also possible, so the CA confirms. |
| `gpayrecharge@icici` | Google Pay recharge | Telephone & Internet, **suggested** | Mobile recharge is the common case; DTH/FASTag recharges also use it. |
| `gpayvoucher@icici` | Google Pay voucher | Suspense | A voucher purchase says nothing about what it is for. |
| `gpay-creditcard@...` | Google Pay card bill | Credit Card Payable (Current Liabilities), **suggested** | Paying a card bill settles a liability; it is not an expense. Payment voucher, not Contra (Contra is only cash ↔ bank). |
| `playstore@axisbank` | Google Play | Software Expenses, **suggested** | App/subscription purchase; could be personal. |
| `*.payu@`, `*.rzp@`, `*.bdpg@` (money out) | the merchant | merchant's ledger | Paying *through* a gateway is a purchase. Settlement ledgers are only for money a gateway pays *you*. |

Before this rule, the bare word "google" mapped every one of these to Software Expenses and auto-confirmed it.

## Statutory dues

| Narration | Ledger | Group | Source |
| --- | --- | --- | --- |
| EPFO, EPF, PF challan | PF Payable | Current Liabilities | [Tally payroll payable ledgers](https://help.tallysolutions.com/docs/te9rel66/Payroll/Creating_Payable_Ledgers.htm) |
| ESIC | ESI Payable | Current Liabilities | [Tally ESI payable ledger](https://help.tallysolutions.com/docs/te9rel63/Payroll/Creating_esi_payable_ledger.htm) |
| PTAX, professional tax | Professional Tax Payable | Current Liabilities | Same group as PF/ESI for consistency; Tally's docs found do not name a group. Confirm per client. |
| GST challan, GSTN, CBIC | GST Payable | Duties & Taxes | |
| TDS, 26Q, 24Q, TIN-NSDL | TDS Payable | Duties & Taxes | |
| ITNS, advance tax, ITD | Income Tax | Loans & Advances (Asset) | |

The bank payment clears the payable created when salaries were booked; it is not a fresh expense.

## Cash and own-account transfers

- ATM, NWD/ATW, cash withdrawal, cash deposit, CDM → **Cash**, Contra voucher.
- A cheque to "SELF" → Cash, **suggested** (usually cash withdrawn at the branch).
- "SELF TRANSFER", "own account" → **Suspense**: could be a transfer to the holder's other bank (Contra), capital introduced, or drawings.

## Cashback treatment

Cashback with no link to a business purchase is income: a ledger under Indirect Incomes, Receipt voucher (Bank Dr, Cashback Received Cr). Cashback or a rebate linked to a purchase reduces the cost of that purchase instead. A post-supply discount has GST consequences (credit note, ITC reversal). The CA decides; that is why the rule is only a suggestion. Background: [Tally indirect incomes](https://help.tallysolutions.com/indirect-incomes-under-gst/), [ClearTax on taxation of cashback](https://cleartax.in/s/taxation-of-cashback).

## Merchant names

Known merchants get one name regardless of spelling, so the CA decides once per merchant: "PAY*Swiggy BANGALORE", "swiggy1online.gpay@", "SWIGGY Bangalore" → Swiggy. Same for Zepto, Zomato, Blinkit, BigBasket, Uber, Ola, Rapido, IRCTC, MakeMyTrip, Flipkart, Myntra, Nykaa, Vodafone Idea, Airtel, Jio, BSNL and Netflix. The ledger for food delivery and quick commerce stays with the CA or AI (staff welfare, office expense or the owner's drawings depend on the client).

## Not covered yet

- Detecting the account holder's own name in narrations (owner transfers → capital, drawings or Contra).
- Reversal pairs (a failed UPI debit and its reversal credit) netted automatically.
- Contra to another bank account (only Cash is offered).
