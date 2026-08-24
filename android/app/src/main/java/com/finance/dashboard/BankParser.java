package com.finance.dashboard;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class BankParser {

    public static class ParsedTransaction {
        public boolean isMatched = false;
        public double amount = 0.0;
        public String merchant = "";
        public String kind = "outgoing"; // outgoing | incoming
        public String note = "";
        public String rawMessage = "";

        public ParsedTransaction(boolean isMatched, double amount, String merchant, String kind, String note, String rawMessage) {
            this.isMatched = isMatched;
            this.amount = amount;
            this.merchant = merchant;
            this.kind = kind;
            this.note = note;
            this.rawMessage = rawMessage;
        }
    }

    public static ParsedTransaction parse(String body) {
        if (body == null || body.trim().isEmpty()) {
            return new ParsedTransaction(false, 0, "", "outgoing", "", "");
        }

        String msg = body.trim();

        // 1. Salary Deposit (Arabic)
        if (Pattern.compile("اضافة راتبك|إضافة راتبك", Pattern.CASE_INSENSITIVE).matcher(msg).find()) {
            double amt = extractAmount(msg, "بمبلغ\\s*([\\d,.]+)\\s*EGP");
            if (amt <= 0) amt = extractAmount(msg, "([\\d,.]+)\\s*EGP");
            if (amt > 0) {
                return new ParsedTransaction(true, amt, "Bank Transfer — Salary", "incoming", "Paycheck Deposit", msg);
            }
        }

        // 2. Instapay Transfer Sent (Outgoing)
        if (Pattern.compile("IPN transfer sent", Pattern.CASE_INSENSITIVE).matcher(msg).find()) {
            double amt = extractAmount(msg, "amount of EGP\\s*([\\d,.]+)");
            if (amt <= 0) amt = extractAmount(msg, "EGP\\s*([\\d,.]+)");
            String fromAcc = extractGroup(msg, "from\\s+([^\\s]+)");
            String source = "Instapay Sent" + (fromAcc.isEmpty() ? "" : " (" + fromAcc + ")");
            if (amt > 0) {
                return new ParsedTransaction(true, amt, source, "outgoing", "IPN Outgoing", msg);
            }
        }

        // 3. Instapay Transfer Received (Incoming)
        if (Pattern.compile("IPN transfer re(ceived|cieved)", Pattern.CASE_INSENSITIVE).matcher(msg).find()) {
            double amt = extractAmount(msg, "amount of EGP\\s*([\\d,.]+)");
            if (amt <= 0) amt = extractAmount(msg, "EGP\\s*([\\d,.]+)");
            String fromAcc = extractGroup(msg, "from\\s+([^\\s]+)");
            String source = "Instapay Received" + (fromAcc.isEmpty() ? "" : " from " + fromAcc);
            if (amt > 0) {
                return new ParsedTransaction(true, amt, source, "incoming", "IPN Transfer", msg);
            }
        }

        // 4. Debit Card Transaction
        if (Pattern.compile("Your Debit Card", Pattern.CASE_INSENSITIVE).matcher(msg).find()) {
            double amt = extractAmount(msg, "transaction of EGP\\s*([\\d,.]+)");
            if (amt <= 0) amt = extractAmount(msg, "EGP\\s*([\\d,.]+)");
            String cardNum = extractGroup(msg, "Debit Card\\s*([^\\s]+)");
            String cardStr = cardNum.isEmpty() ? "Debit Card" : "Debit Card " + cardNum;
            String merchant = extractGroup(msg, "@([^,]+)");
            if (merchant.isEmpty()) merchant = cardStr;
            if (amt > 0) {
                return new ParsedTransaction(true, amt, merchant.trim(), "outgoing", cardStr, msg);
            }
        }

        // 5. Credit Card Transaction
        if (Pattern.compile("Your Credit Card", Pattern.CASE_INSENSITIVE).matcher(msg).find()) {
            double amt = extractAmount(msg, "transaction of EGP\\s*([\\d,.]+)");
            if (amt <= 0) amt = extractAmount(msg, "EGP\\s*([\\d,.]+)");
            String cardNum = extractGroup(msg, "Credit Card\\s*([^\\s]+)");
            String cardStr = cardNum.isEmpty() ? "Credit Card" : "Credit Card " + cardNum;
            String merchant = extractGroup(msg, "@([^,]+)");
            if (merchant.isEmpty()) merchant = cardStr;
            if (amt > 0) {
                return new ParsedTransaction(true, amt, merchant.trim(), "outgoing", cardStr, msg);
            }
        }

        // 6. Refunds / Reversals
        if (Pattern.compile("Reversed|Refunded|استرجاع", Pattern.CASE_INSENSITIVE).matcher(msg).find()) {
            double amt = extractAmount(msg, "EGP\\s*([\\d,.]+)");
            if (amt <= 0) amt = extractAmount(msg, "([\\d,.]+)\\s*EGP");
            if (amt > 0) {
                return new ParsedTransaction(true, amt, "Refund / Reversal", "incoming", "Reversed Transaction", msg);
            }
        }

        return new ParsedTransaction(false, 0, "", "outgoing", "", msg);
    }

    private static double extractAmount(String text, String regex) {
        try {
            Matcher m = Pattern.compile(regex, Pattern.CASE_INSENSITIVE).matcher(text);
            if (m.find()) {
                String val = m.group(1).replace(",", "");
                return Double.parseDouble(val);
            }
        } catch (Exception ignored) {}
        return 0.0;
    }

    private static String extractGroup(String text, String regex) {
        try {
            Matcher m = Pattern.compile(regex, Pattern.CASE_INSENSITIVE).matcher(text);
            if (m.find()) {
                return m.group(1).trim();
            }
        } catch (Exception ignored) {}
        return "";
    }
}
