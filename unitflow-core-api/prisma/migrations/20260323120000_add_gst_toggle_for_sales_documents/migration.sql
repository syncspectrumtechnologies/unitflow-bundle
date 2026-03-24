-- GST/non-GST document mode support
ALTER TABLE "Company"
  ADD COLUMN IF NOT EXISTS "is_gst_enabled" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "SalesCompany"
  ADD COLUMN IF NOT EXISTS "is_gst_enabled" BOOLEAN;

ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "is_gst_invoice" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "Invoice"
  ADD COLUMN IF NOT EXISTS "is_gst_invoice" BOOLEAN NOT NULL DEFAULT true;
