package com.finance.dashboard;

import org.junit.Test;
import static org.junit.Assert.*;

public class BankParserTest {
    @Test public void parsesDebitCardExpense() {
        BankParser.ParsedTransaction tx = BankParser.parse("Your Debit Card ****1234 transaction of EGP 1,250.50 @STARBUCKS, Cairo");
        assertTrue(tx.isMatched);
        assertEquals(1250.50, tx.amount, 0.001);
        assertEquals("outgoing", tx.kind);
        assertEquals("STARBUCKS", tx.merchant);
    }

    @Test public void parsesArabicSalary() {
        BankParser.ParsedTransaction tx = BankParser.parse("تم إضافة راتبك بمبلغ 25,000 EGP");
        assertTrue(tx.isMatched);
        assertEquals(25000.0, tx.amount, 0.001);
        assertEquals("incoming", tx.kind);
    }

    @Test public void parsesCreditCardExpense() {
        BankParser.ParsedTransaction tx = BankParser.parse("Your Credit Card ****9350 had a Successful transaction of EGP 78 @MOHAMED ABD ELSATTAR ABD, your available bal.EGP 9663.86. For Inquiries call 19700.");
        assertTrue(tx.isMatched);
        assertEquals(78.0, tx.amount, 0.001);
        assertEquals("outgoing", tx.kind);
        assertEquals("MOHAMED ABD ELSATTAR ABD", tx.merchant);
    }

    @Test public void parsesInstapaySent() {
        BankParser.ParsedTransaction tx = BankParser.parse("IPN transfer sent with amount of EGP 180.00 from 8472 on 19/08 at 02:35 PM. Ref# 54d77d7c. For more details call 19700.");
        assertTrue(tx.isMatched);
        assertEquals(180.0, tx.amount, 0.001);
        assertEquals("outgoing", tx.kind);
        assertTrue(tx.merchant.contains("Instapay Sent"));
    }

    @Test public void parsesInstapayReceived() {
        BankParser.ParsedTransaction tx = BankParser.parse("IPN transfer received with amount of EGP 180.00 from 8472 on 19/08 at 02:35 PM. Ref# 54d77d7c. For more details call 19700.");
        assertTrue(tx.isMatched);
        assertEquals(180.0, tx.amount, 0.001);
        assertEquals("incoming", tx.kind);
        assertTrue(tx.merchant.contains("Instapay Received"));
    }

    @Test public void ignoresUnrelatedSms() {
        assertFalse(BankParser.parse("Your verification code is 123456").isMatched);
        assertFalse(BankParser.parse("Special offer! Get 20% off on all items this weekend.").isMatched);
    }
}

