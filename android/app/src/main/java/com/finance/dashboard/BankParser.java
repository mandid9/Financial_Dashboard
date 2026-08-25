package com.finance.dashboard;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

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
        public String defaultCategory = "";

        public ParsedTransaction(boolean isMatched, double amount, String merchant, String kind, String note, String rawMessage, String defaultCategory) {
            this.isMatched = isMatched;
            this.amount = amount;
            this.merchant = merchant;
            this.kind = kind;
            this.note = note;
            this.rawMessage = rawMessage;
            this.defaultCategory = defaultCategory;
        }

        public ParsedTransaction(boolean isMatched, double amount, String merchant, String kind, String note, String rawMessage) {
            this(isMatched, amount, merchant, kind, note, rawMessage, "");
        }
    }

    public static ParsedTransaction parse(Context context, String body) {
        return parse(context, body, "");
    }

    public static ParsedTransaction parse(Context context, String body, String sender) {
        if (body == null || body.trim().isEmpty()) {
            return new ParsedTransaction(false, 0, "", "outgoing", "", "");
        }

        String msg = body.trim();

        // 1. Check Dynamic Custom Rules Cached in SharedPreferences (Hybrid Approach)
        if (context != null) {
            SharedPreferences prefs = context.getSharedPreferences("finance_prefs", Context.MODE_PRIVATE);
            String customRulesJson = prefs.getString("custom_sms_rules", "");
            if (!customRulesJson.isEmpty()) {
                try {
                    JSONArray rules = new JSONArray(customRulesJson);
                    for (int i = 0; i < rules.length(); i++) {
                        JSONObject rule = rules.getJSONObject(i);
                        String keyword = rule.optString("contentPattern", rule.optString("keyword", ""));
                        String senderPattern = rule.optString("senderPattern", "");
                        String catchMode = rule.optString("catchMode", "catch");
                        boolean senderMatches = senderPattern.isEmpty() || (sender != null && sender.toLowerCase().contains(senderPattern.toLowerCase()));
                        boolean contentMatches = keyword.isEmpty() || msg.toLowerCase().contains(keyword.toLowerCase());
                        if (!"ignore".equalsIgnoreCase(catchMode) && senderMatches && contentMatches) {
                            double amt = extractGenericAmount(msg);
                            if (amt > 0) {
                                String name = rule.optString("name", keyword);
                                String kind = rule.optString("direction", rule.optString("kind", "outgoing"));
                                if ("auto".equalsIgnoreCase(kind)) kind = "outgoing";
                                String category = rule.optString("category", rule.optString("categoryId", ""));
                                return new ParsedTransaction(true, amt, name, kind, "Custom Rule: " + name, msg, category);
                            }
                        }
                    }
                } catch (Exception ignored) {}
            }
        }

        // 2. Built-in Egyptian Bank Rules (Default Fallback)

        // A. Salary Deposit (Arabic)
        if (Pattern.compile("اضافة راتبك|إضافة راتبك", Pattern.CASE_INSENSITIVE).matcher(msg).find()) {
            double amt = extractAmount(msg, "بمبلغ\\s*([\\d,.]+)\\s*EGP");
            if (amt <= 0) amt = extractAmount(msg, "([\\d,.]+)\\s*EGP");
            if (amt > 0) {
                return new ParsedTransaction(true, amt, "Bank Transfer — Salary", "incoming", "Paycheck Deposit", msg);
            }
        }

        // B. Instapay Transfer Sent (Outgoing)
        if (Pattern.compile("IPN transfer sent", Pattern.CASE_INSENSITIVE).matcher(msg).find()) {
            double amt = extractAmount(msg, "amount of EGP\\s*([\\d,.]+)");
            if (amt <= 0) amt = extractAmount(msg, "EGP\\s*([\\d,.]+)");
            String fromAcc = extractGroup(msg, "from\\s+([^\\s]+)");
            String source = "Instapay Sent" + (fromAcc.isEmpty() ? "" : " (" + fromAcc + ")");
            if (amt > 0) {
                return new ParsedTransaction(true, amt, source, "outgoing", "IPN Outgoing", msg);
            }
        }

        // C. Instapay Transfer Received (Incoming)
        if (Pattern.compile("IPN transfer re(ceived|cieved)", Pattern.CASE_INSENSITIVE).matcher(msg).find()) {
            double amt = extractAmount(msg, "amount of EGP\\s*([\\d,.]+)");
            if (amt <= 0) amt = extractAmount(msg, "EGP\\s*([\\d,.]+)");
            String fromAcc = extractGroup(msg, "from\\s+([^\\s]+)");
            String source = "Instapay Received" + (fromAcc.isEmpty() ? "" : " from " + fromAcc);
            if (amt > 0) {
                return new ParsedTransaction(true, amt, source, "incoming", "IPN Transfer", msg);
            }
        }

        // D. Debit Card Transaction
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

        // E. Credit Card Transaction
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

        // F. Refunds / Reversals
        if (Pattern.compile("Reversed|Refunded|استرجاع", Pattern.CASE_INSENSITIVE).matcher(msg).find()) {
            double amt = extractAmount(msg, "EGP\\s*([\\d,.]+)");
            if (amt <= 0) amt = extractAmount(msg, "([\\d,.]+)\\s*EGP");
            if (amt > 0) {
                return new ParsedTransaction(true, amt, "Refund / Reversal", "incoming", "Reversed Transaction", msg);
            }
        }

        return new ParsedTransaction(false, 0, "", "outgoing", "", msg);
    }

    public static ParsedTransaction parse(String body) {
        return parse(null, body);
    }

    private static double extractGenericAmount(String text) {
        double amt = extractAmount(text, "(?:EGP|LE|L\\.E|ج\\.م)\\s*([\\d,.]+)");
        if (amt <= 0) amt = extractAmount(text, "([\\d,.]+)\\s*(?:EGP|LE|L\\.E|ج\\.م)");
        if (amt <= 0) amt = extractAmount(text, "amount of\\s*([\\d,.]+)");
        return amt;
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