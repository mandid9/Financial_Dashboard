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

    @Test public void ignoresUnrelatedSms() {
        assertFalse(BankParser.parse("Your verification code is 123456").isMatched);
    }
}

