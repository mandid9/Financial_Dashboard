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

    public static String normalizeSender(String sender) {
        if (sender == null) return "";
        return sender.replaceAll("[^a-zA-Z0-9]", "").toUpperCase(java.util.Locale.ROOT);
    }

    public static boolean isTrustedBankSender(String sender) {
        if (sender == null || sender.trim().isEmpty()) return false;
        String norm = normalizeSender(sender);
        return norm.contains("CIB") || norm.contains("NBE") || norm.contains("INSTAPAY") ||
               norm.contains("BDC") || norm.contains("QNB") || norm.contains("HSBC") ||
               norm.contains("BANQUEMISR") || norm.contains("MISR") || norm.contains("VFCASH") ||
               norm.contains("ETCASH") || norm.contains("ALEXBANK") || norm.contains("AAIB") ||
               norm.contains("FABMISR") || norm.contains("SAIB") || norm.contains("EGBANK") ||
               norm.contains("ADIB") || norm.contains("FAWRY") || norm.contains("TELDA") ||
               norm.contains("WEPAY") || norm.contains("ORANGE") || norm.contains("VODAFONE") ||
               norm.contains("ETISALAT") || norm.contains("CASH");
    }

    public static String normalizeDigits(String text) {
        if (text == null) return "";
        return text
            .replace('٠', '0').replace('١', '1').replace('٢', '2')
            .replace('٣', '3').replace('٤', '4').replace('٥', '5')
            .replace('٦', '6').replace('٧', '7').replace('٨', '8')
            .replace('٩', '9')
            .replace('،', ',');
    }

    public static boolean isPromotionalMessage(String msg) {
        if (msg == null || msg.isEmpty()) return false;
        return Pattern.compile(
            "عرض خاص|اشحن|احصل على|خصم يصل|لفترة محدودة|كود الخصم|مبروك|وفر مع|استمتع بـ|استمتع بخصم|اشترك الآن|اشترك الان|شحنتك|" +
            "كول تون|رنة المتصل|رنتلي|تجديد رنة|رصيدك الحالي|رصيدك المتاح|متبقي من باقتك|رصيد محفظتك|" +
            "كود التأكيد|رمز التحقق|رمز الأمان|لا تشارك|استبدل نقاطك|صندوق الهدايا|كاش باك|" +
            "على النوتة|سلفة|فليكسات|فليكس 80|فليكس 70|فليكس 100|فليكس 200|" +
            "AutoBill\\s*:|في حسابك بنجاح.*(?:اورنچ|فودافون|اتصالات|وي|تقدر تدفع|كارت البنك)|تأكيد سداد الفاتورة|" +
            "promo|offer|discount up to|special offer|recharge now|win up to|subscribe now|voucher code|coupon|get free|valid until|" +
            "call tone|current.*balance|balance is|available balance|otp[:\\s]|verification code|one-time password|reward points",
            Pattern.CASE_INSENSITIVE
        ).matcher(msg).find();
    }

    public static ParsedTransaction parse(Context context, String sender, String body) {
        if (body == null || body.trim().isEmpty()) {
            return new ParsedTransaction(false, 0, "", "outgoing", "", "");
        }

        String rawMsg = body.trim();
        String msg = normalizeDigits(rawMsg);
        String senderStr = sender != null ? sender.trim() : "";
        boolean isBank = isTrustedBankSender(senderStr);

        // 1. Check Dynamic Custom Rules Cached in SharedPreferences
        if (context != null) {
            SharedPreferences prefs = context.getSharedPreferences("finance_prefs", Context.MODE_PRIVATE);
            String customRulesJson = prefs.getString("custom_sms_rules", "");
            if (!customRulesJson.isEmpty()) {
                try {
                    JSONArray rules = new JSONArray(customRulesJson);
                    for (int i = 0; i < rules.length(); i++) {
                        JSONObject rule = rules.getJSONObject(i);
                        if (!rule.optBoolean("isActive", true)) continue;

                        String ruleSender = rule.optString("senderPattern", "").trim();
                        String ruleContent = rule.optString("contentPattern", "").trim();
                        if (ruleContent.isEmpty()) {
                            ruleContent = rule.optString("keyword", "").trim();
                        }

                        // Determine sender match
                        boolean senderMatches = true;
                        if (!ruleSender.isEmpty()) {
                            if (senderStr.isEmpty()) {
                                senderMatches = false;
                            } else {
                                String normSender = normalizeSender(senderStr);
                                String normRuleSender = normalizeSender(ruleSender);
                                senderMatches = normSender.contains(normRuleSender) || senderStr.equalsIgnoreCase(ruleSender);
                            }
                        }

                        // Determine body match
                        boolean bodyMatches = true;
                        if (!ruleContent.isEmpty()) {
                            bodyMatches = msg.toLowerCase().contains(ruleContent.toLowerCase());
                        }

                        // If rule specified neither, skip
                        if (ruleSender.isEmpty() && ruleContent.isEmpty()) continue;

                        // Both sender AND content pattern must match if specified!
                        if (senderMatches && bodyMatches) {
                            String catchMode = rule.optString("catchMode", "catch");
                            if ("ignore".equalsIgnoreCase(catchMode)) {
                                return new ParsedTransaction(false, 0, "", "outgoing", "", rawMsg);
                            }

                            double amt = extractGenericAmount(msg);
                            if (amt > 0) {
                                String name = rule.optString("name", !ruleSender.isEmpty() ? ruleSender : ruleContent);
                                String kind = rule.optString("direction", rule.optString("kind", "outgoing"));
                                if ("auto".equalsIgnoreCase(kind)) kind = "outgoing";
                                String category = rule.optString("category", "");
                                String merchant = extractMerchantName(msg);
                                if (merchant.isEmpty() || merchant.equals("Bank Card")) {
                                    merchant = name;
                                }
                                return new ParsedTransaction(true, amt, merchant, kind, "Custom Rule: " + name, rawMsg, category);
                            }
                        }
                    }
                } catch (Exception ignored) {}
            }
        }

        // Fast reject: If promotional message, ignore immediately
        if (isPromotionalMessage(msg)) {
            return new ParsedTransaction(false, 0, "", "outgoing", "", rawMsg);
        }

        // 2. Specialized Egyptian Bank Templates

        // A. Salary / Payroll Deposit
        if (Pattern.compile("اضافة راتبك|إضافة راتبك|تم ايداع الراتب|تحويل الراتب|Salary|payroll", Pattern.CASE_INSENSITIVE).matcher(msg).find()) {
            double amt = extractAmount(msg, "(?:بمبلغ|مبلغ|amount of)?\\s*([\\d,.]+)\\s*(?:EGP|LE|L\\.E|ج\\.م|جنيه)");
            if (amt <= 0) amt = extractGenericAmount(msg);
            if (amt > 0) {
                return new ParsedTransaction(true, amt, "Salary Deposit", "incoming", "Paycheck Deposit", rawMsg, "Income");
            }
        }

        // B. InstaPay Transfers (IPN)
        if (Pattern.compile("IPN transfer sent|تحويل عبر انستاباي|انستاباي.*خصم", Pattern.CASE_INSENSITIVE).matcher(msg).find()) {
            double amt = extractGenericAmount(msg);
            String toAcc = extractGroup(msg, "(?:to|إلى)\\s+([^,\\.\\n]+)");
            String source = "Instapay Sent" + (toAcc.isEmpty() ? "" : " to " + toAcc);
            if (amt > 0) {
                return new ParsedTransaction(true, amt, source, "outgoing", "IPN Outgoing", rawMsg);
            }
        }
        if (Pattern.compile("IPN transfer re(ceived|cieved)|استلام تحويل.*انستاباي", Pattern.CASE_INSENSITIVE).matcher(msg).find()) {
            double amt = extractGenericAmount(msg);
            String fromAcc = extractGroup(msg, "(?:from|من)\\s+([^,\\.\\n]+)");
            String source = "Instapay Received" + (fromAcc.isEmpty() ? "" : " from " + fromAcc);
            if (amt > 0) {
                return new ParsedTransaction(true, amt, source, "incoming", "IPN Transfer", rawMsg);
            }
        }

        // C. NBE (National Bank of Egypt) & CIB & Banque Misr & QNB Templates
        if (Pattern.compile("تم (?:تنفيذ |إجراء )?حركة|مشتريات|حركة شراء|حركة خصم|تمت معاملة", Pattern.CASE_INSENSITIVE).matcher(msg).find()) {
            double amt = extractGenericAmount(msg);
            String merchant = extractMerchantName(msg);
            if (amt > 0) {
                return new ParsedTransaction(true, amt, merchant, "outgoing", "Card Purchase", rawMsg);
            }
        }

        // English Card Purchase (QNB, NBE, CIB, HSBC, FABMISR, AlexBank)
        if (Pattern.compile("Your (?:Debit|Credit) Card|Purchase (?:of|transaction)|Card (?:ending|used)|was used for", Pattern.CASE_INSENSITIVE).matcher(msg).find()) {
            double amt = extractGenericAmount(msg);
            String merchant = extractMerchantName(msg);
            if (amt > 0) {
                return new ParsedTransaction(true, amt, merchant, "outgoing", "Card Purchase", rawMsg);
            }
        }

        // D. Mobile Wallets (Vodafone Cash, Etisalat Cash, Orange Cash, WE Pay)
        if (Pattern.compile("Vodafone Cash|فودافون كاش|اورنچ كاش|اتصالات كاش|وي باي|تم (?:تحويل|دفع|استلام|خصم) مبلغ", Pattern.CASE_INSENSITIVE).matcher(msg).find()) {
            double amt = extractGenericAmount(msg);
            boolean isIncoming = Pattern.compile("استلام|إيداع|received|deposit", Pattern.CASE_INSENSITIVE).matcher(msg).find();
            String merchant = extractMerchantName(msg);
            if (merchant.isEmpty() || merchant.equals("Bank Card")) {
                merchant = isIncoming ? "Wallet Received" : "Wallet Payment";
            }
            if (amt > 0) {
                return new ParsedTransaction(true, amt, merchant, isIncoming ? "incoming" : "outgoing", "Mobile Wallet", rawMsg);
            }
        }

        // E. Refunds / Reversals
        if (Pattern.compile("Reversed|Refunded|استرجاع|رد مبلغ", Pattern.CASE_INSENSITIVE).matcher(msg).find()) {
            double amt = extractGenericAmount(msg);
            if (amt > 0) {
                return new ParsedTransaction(true, amt, "Refund / Reversal", "incoming", "Reversed Transaction", rawMsg);
            }
        }

        // 3. Universal Smart Parser - ONLY for trusted bank senders to prevent marketing/promotional false positives!
        if (isBank) {
            double genericAmt = extractGenericAmount(msg);
            if (genericAmt > 0) {
                boolean isFinancial = Pattern.compile(
                    "purchase|payment|spent|transfer|debit|credit|pos|atm|cash|withdraw|invoice|order|paid|bill|wallet|card|" +
                    "خصم|شراء|مشتريات|سحب|دفع|تحويل|بطاقة|كارت|فاتورة|محفظة|معاملة|حركة|رصيد",
                    Pattern.CASE_INSENSITIVE
                ).matcher(msg).find();

                if (isFinancial) {
                    boolean isIncoming = Pattern.compile(
                        "received|deposit|salary|refund|reversed|cashback|ايداع|إيداع|استلام|اضافة|إضافة|راتب|مرتب|استرجاع|وارد",
                        Pattern.CASE_INSENSITIVE
                    ).matcher(msg).find();

                    String merchant = extractMerchantName(msg);
                    if (merchant.isEmpty() || merchant.equals("Bank Card")) {
                        if (!senderStr.isEmpty()) {
                            merchant = senderStr;
                        }
                    }

                    return new ParsedTransaction(true, genericAmt, merchant, isIncoming ? "incoming" : "outgoing", "Bank Notification", rawMsg);
                }
            }
        }

        return new ParsedTransaction(false, 0, "", "outgoing", "", rawMsg);
    }

    public static ParsedTransaction parse(Context context, String body) {
        return parse(context, "", body);
    }

    public static ParsedTransaction parse(String body) {
        return parse(null, "", body);
    }

    private static String extractMerchantName(String text) {
        // Match @Merchant
        String atMatch = extractGroup(text, "@([^,\\.\\n]+)");
        if (!atMatch.isEmpty()) return atMatch.trim();

        // Match at Merchant
        String atWord = extractGroup(text, "(?:at|AT|At)\\s+([^,\\.\\n]+)");
        if (!atWord.isEmpty() && !atWord.toLowerCase().startsWith("pos") && !atWord.toLowerCase().startsWith("atm")) {
            return atWord.trim();
        }

        // Match لدى Merchant or عند Merchant
        String arabicMerchant = extractGroup(text, "(?:لدى|عند|لـ|إلى)\\s+([^,\\.\\n]+)");
        if (!arabicMerchant.isEmpty()) return arabicMerchant.trim();

        // Match card string
        String cardNum = extractGroup(text, "(?:Debit|Credit|بطاقة)\\s*(?:Card|المنتهية بـ|المنتهية بـ )?\\s*([\\w*]+)");
        if (!cardNum.isEmpty()) {
            return "Card " + cardNum;
        }

        return "Bank Card";
    }

    private static double extractGenericAmount(String text) {
        double amt = extractAmount(text, "(?:EGP|LE|L\\.E|ج\\.م|جنيه|مبلغ)\\s*([\\d,.]+)");
        if (amt <= 0) amt = extractAmount(text, "([\\d,.]+)\\s*(?:EGP|LE|L\\.E|ج\\.م|جنيه)");
        if (amt <= 0) amt = extractAmount(text, "(?:amount of|بمبلغ)\\s*([\\d,.]+)");
        if (amt <= 0) amt = extractAmount(text, "([\\d,.]+)\\s*(?:ج\\.م)");
        return amt;
    }

    private static double extractAmount(String text, String regex) {
        try {
            Matcher m = Pattern.compile(regex, Pattern.CASE_INSENSITIVE).matcher(text);
            if (m.find()) {
                String val = m.group(1).replace(",", "").trim();
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
