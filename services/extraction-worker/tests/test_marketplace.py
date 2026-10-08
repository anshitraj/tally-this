import unittest
from app.extractors.marketplace import extract_marketplace_rows


class MarketplaceTests(unittest.TestCase):
    def test_amazon_like_row(self):
        rows = extract_marketplace_rows([
            {
                "Order ID": "AMZ-1",
                "Invoice Number": "INV-1",
                "Invoice Date": "01/05/2026",
                "Taxable Value": "1000",
                "CGST": "90",
                "SGST": "90",
                "IGST": "0",
                "Gross Amount": "1180",
                "HSN": "6109",
                "GST Rate": "18",
                "Transaction Type": "sale",
                "_row_number": 2,
            }
        ], "amazon", "amazon.csv")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["invoice_number"], "INV-1")
        self.assertEqual(rows[0]["gross_amount"], 1180)
        self.assertEqual(rows[0]["issues"], [])


if __name__ == "__main__":
    unittest.main()
