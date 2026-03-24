-- Phase 7 / 8 / 9 foundation:
-- GST billing, tracked inventory, purchase receiving and returns maturity

DO $$ BEGIN
  CREATE TYPE "GstRegistrationType" AS ENUM ('REGISTERED', 'UNREGISTERED', 'COMPOSITION', 'EXPORT', 'SEZ', 'EXEMPT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "GstSupplyType" AS ENUM ('INTRA_STATE', 'INTER_STATE', 'EXPORT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ProductTrackingMode" AS ENUM ('NONE', 'BARCODE_ONLY', 'SERIAL_ONLY', 'BATCH_ONLY', 'BATCH_EXPIRY', 'SERIAL_BATCH', 'SERIAL_BATCH_EXPIRY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "SerialStatus" AS ENUM ('IN_STOCK', 'RESERVED', 'DISPATCHED', 'RETURNED', 'SCRAPPED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "PurchaseReceiptStatus" AS ENUM ('DRAFT', 'POSTED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "SupplierReturnStatus" AS ENUM ('DRAFT', 'APPROVED', 'DISPATCHED', 'COMPLETED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "DeliveryChallanStatus" AS ENUM ('DRAFT', 'ISSUED', 'CLOSED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "DeliveryChallanKind" AS ENUM ('OUTWARD', 'INWARD', 'JOB_WORK', 'RETURNABLE', 'NON_RETURNABLE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "DeliveryChallanReason" AS ENUM ('SALE', 'RETURN', 'JOB_WORK', 'SAMPLE', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TYPE "PurchaseStatus" ADD VALUE IF NOT EXISTS 'PARTIALLY_RECEIVED';

ALTER TABLE "Company"
  ADD COLUMN IF NOT EXISTS "legal_name" TEXT,
  ADD COLUMN IF NOT EXISTS "gstin" TEXT,
  ADD COLUMN IF NOT EXISTS "gst_registration_type" "GstRegistrationType",
  ADD COLUMN IF NOT EXISTS "phone" TEXT,
  ADD COLUMN IF NOT EXISTS "email" TEXT,
  ADD COLUMN IF NOT EXISTS "address" TEXT,
  ADD COLUMN IF NOT EXISTS "state" TEXT,
  ADD COLUMN IF NOT EXISTS "state_code" TEXT;

ALTER TABLE "SalesCompany"
  ADD COLUMN IF NOT EXISTS "legal_name" TEXT,
  ADD COLUMN IF NOT EXISTS "gstin" TEXT,
  ADD COLUMN IF NOT EXISTS "gst_registration_type" "GstRegistrationType",
  ADD COLUMN IF NOT EXISTS "phone" TEXT,
  ADD COLUMN IF NOT EXISTS "email" TEXT,
  ADD COLUMN IF NOT EXISTS "address" TEXT,
  ADD COLUMN IF NOT EXISTS "state" TEXT,
  ADD COLUMN IF NOT EXISTS "state_code" TEXT;

ALTER TABLE "Factory"
  ADD COLUMN IF NOT EXISTS "state" TEXT,
  ADD COLUMN IF NOT EXISTS "state_code" TEXT;

ALTER TABLE "Product"
  ADD COLUMN IF NOT EXISTS "tax_class_id" TEXT,
  ADD COLUMN IF NOT EXISTS "hsn_sac_code" TEXT,
  ADD COLUMN IF NOT EXISTS "gst_rate" DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS "cess_rate" DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS "tracking_mode" "ProductTrackingMode" NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS "shelf_life_days" INTEGER;

ALTER TABLE "Client"
  ADD COLUMN IF NOT EXISTS "gst_registration_type" "GstRegistrationType",
  ADD COLUMN IF NOT EXISTS "state" TEXT,
  ADD COLUMN IF NOT EXISTS "state_code" TEXT,
  ADD COLUMN IF NOT EXISTS "pincode" TEXT;

ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "place_of_supply_state" TEXT,
  ADD COLUMN IF NOT EXISTS "place_of_supply_code" TEXT,
  ADD COLUMN IF NOT EXISTS "supply_type" "GstSupplyType",
  ADD COLUMN IF NOT EXISTS "tax_subtotal" DECIMAL(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "cgst_total" DECIMAL(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "sgst_total" DECIMAL(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "igst_total" DECIMAL(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "cess_total" DECIMAL(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "round_off" DECIMAL(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "gst_breakup" JSONB;

ALTER TABLE "OrderItem"
  ADD COLUMN IF NOT EXISTS "hsn_sac_code" TEXT,
  ADD COLUMN IF NOT EXISTS "gst_rate" DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS "cgst_rate" DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS "sgst_rate" DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS "igst_rate" DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS "cess_rate" DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS "taxable_value" DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS "tax_amount" DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS "cgst_amount" DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS "sgst_amount" DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS "igst_amount" DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS "cess_amount" DECIMAL(15,2);

ALTER TABLE "Invoice"
  ADD COLUMN IF NOT EXISTS "reference_invoice_id" TEXT,
  ADD COLUMN IF NOT EXISTS "place_of_supply_state" TEXT,
  ADD COLUMN IF NOT EXISTS "place_of_supply_code" TEXT,
  ADD COLUMN IF NOT EXISTS "supply_type" "GstSupplyType",
  ADD COLUMN IF NOT EXISTS "tax_subtotal" DECIMAL(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "cgst_total" DECIMAL(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "sgst_total" DECIMAL(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "igst_total" DECIMAL(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "cess_total" DECIMAL(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "round_off" DECIMAL(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "gst_breakup" JSONB;

ALTER TABLE "InvoiceItem"
  ADD COLUMN IF NOT EXISTS "hsn_sac_code" TEXT,
  ADD COLUMN IF NOT EXISTS "gst_rate" DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS "cgst_rate" DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS "sgst_rate" DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS "igst_rate" DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS "cess_rate" DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS "taxable_value" DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS "tax_amount" DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS "cgst_amount" DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS "sgst_amount" DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS "igst_amount" DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS "cess_amount" DECIMAL(15,2);

ALTER TABLE "Purchase"
  ADD COLUMN IF NOT EXISTS "vendor_gst_registration_type" "GstRegistrationType",
  ADD COLUMN IF NOT EXISTS "vendor_state" TEXT,
  ADD COLUMN IF NOT EXISTS "vendor_state_code" TEXT,
  ADD COLUMN IF NOT EXISTS "supply_type" "GstSupplyType",
  ADD COLUMN IF NOT EXISTS "tax_subtotal" DECIMAL(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "total_charges" DECIMAL(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "cgst_total" DECIMAL(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "sgst_total" DECIMAL(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "igst_total" DECIMAL(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "cess_total" DECIMAL(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "round_off" DECIMAL(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "gst_breakup" JSONB;

ALTER TABLE "PurchaseItem"
  ADD COLUMN IF NOT EXISTS "product_id" TEXT,
  ADD COLUMN IF NOT EXISTS "unit" TEXT,
  ADD COLUMN IF NOT EXISTS "received_quantity" DECIMAL(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "returned_quantity" DECIMAL(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "discount" DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS "hsn_sac_code" TEXT,
  ADD COLUMN IF NOT EXISTS "gst_rate" DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS "cgst_rate" DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS "sgst_rate" DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS "igst_rate" DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS "cess_rate" DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS "taxable_value" DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS "tax_amount" DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS "cgst_amount" DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS "sgst_amount" DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS "igst_amount" DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS "cess_amount" DECIMAL(15,2);

ALTER TABLE "PurchaseCharge"
  ADD COLUMN IF NOT EXISTS "type" "ChargeType" NOT NULL DEFAULT 'OTHER',
  ADD COLUMN IF NOT EXISTS "meta" JSONB;

CREATE TABLE IF NOT EXISTS "TaxClass" (
  "id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "hsn_sac_code" TEXT,
  "gst_rate" DECIMAL(5,2) NOT NULL DEFAULT 0,
  "cess_rate" DECIMAL(5,2) NOT NULL DEFAULT 0,
  "description" TEXT,
  "is_active" BOOLEAN NOT NULL DEFAULT TRUE,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TaxClass_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TaxClass_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "TaxClass_company_id_name_key" ON "TaxClass"("company_id", "name");
CREATE INDEX IF NOT EXISTS "TaxClass_company_id_is_active_idx" ON "TaxClass"("company_id", "is_active");

CREATE TABLE IF NOT EXISTS "ProductBarcode" (
  "id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "product_id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "alias_type" TEXT,
  "is_primary" BOOLEAN NOT NULL DEFAULT FALSE,
  "is_active" BOOLEAN NOT NULL DEFAULT TRUE,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductBarcode_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProductBarcode_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ProductBarcode_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "ProductBarcode_company_id_code_key" ON "ProductBarcode"("company_id", "code");
CREATE INDEX IF NOT EXISTS "ProductBarcode_company_id_product_id_is_active_idx" ON "ProductBarcode"("company_id", "product_id", "is_active");

CREATE TABLE IF NOT EXISTS "InventoryBatch" (
  "id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "factory_id" TEXT NOT NULL,
  "product_id" TEXT NOT NULL,
  "batch_no" TEXT NOT NULL,
  "expiry_date" TIMESTAMP(3),
  "manufacture_date" TIMESTAMP(3),
  "barcode" TEXT,
  "location_label" TEXT,
  "notes" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InventoryBatch_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InventoryBatch_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "InventoryBatch_factory_id_fkey" FOREIGN KEY ("factory_id") REFERENCES "Factory"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "InventoryBatch_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "InventoryBatch_company_id_factory_id_product_id_batch_no_key" ON "InventoryBatch"("company_id", "factory_id", "product_id", "batch_no");
CREATE INDEX IF NOT EXISTS "InventoryBatch_company_id_product_id_expiry_date_idx" ON "InventoryBatch"("company_id", "product_id", "expiry_date");
CREATE INDEX IF NOT EXISTS "InventoryBatch_company_id_factory_id_location_label_idx" ON "InventoryBatch"("company_id", "factory_id", "location_label");

CREATE TABLE IF NOT EXISTS "InventorySerial" (
  "id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "factory_id" TEXT NOT NULL,
  "product_id" TEXT NOT NULL,
  "batch_id" TEXT,
  "serial_no" TEXT NOT NULL,
  "barcode" TEXT,
  "expiry_date" TIMESTAMP(3),
  "location_label" TEXT,
  "status" "SerialStatus" NOT NULL DEFAULT 'IN_STOCK',
  "last_movement_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InventorySerial_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InventorySerial_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "InventorySerial_factory_id_fkey" FOREIGN KEY ("factory_id") REFERENCES "Factory"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "InventorySerial_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "InventorySerial_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "InventoryBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "InventorySerial_company_id_serial_no_key" ON "InventorySerial"("company_id", "serial_no");
CREATE INDEX IF NOT EXISTS "InventorySerial_company_id_product_id_status_idx" ON "InventorySerial"("company_id", "product_id", "status");
CREATE INDEX IF NOT EXISTS "InventorySerial_company_id_factory_id_location_label_idx" ON "InventorySerial"("company_id", "factory_id", "location_label");

CREATE TABLE IF NOT EXISTS "InventoryMovementTracking" (
  "id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "factory_id" TEXT NOT NULL,
  "product_id" TEXT NOT NULL,
  "movement_id" TEXT NOT NULL,
  "batch_id" TEXT,
  "serial_id" TEXT,
  "barcode" TEXT,
  "expiry_date" TIMESTAMP(3),
  "location_label" TEXT,
  "quantity" DECIMAL(15,2) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InventoryMovementTracking_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InventoryMovementTracking_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "InventoryMovementTracking_factory_id_fkey" FOREIGN KEY ("factory_id") REFERENCES "Factory"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "InventoryMovementTracking_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "InventoryMovementTracking_movement_id_fkey" FOREIGN KEY ("movement_id") REFERENCES "InventoryMovement"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "InventoryMovementTracking_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "InventoryBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "InventoryMovementTracking_serial_id_fkey" FOREIGN KEY ("serial_id") REFERENCES "InventorySerial"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "InventoryMovementTracking_company_id_movement_id_idx" ON "InventoryMovementTracking"("company_id", "movement_id");
CREATE INDEX IF NOT EXISTS "InventoryMovementTracking_company_id_product_id_batch_id_idx" ON "InventoryMovementTracking"("company_id", "product_id", "batch_id");
CREATE INDEX IF NOT EXISTS "InventoryMovementTracking_company_id_product_id_serial_id_idx" ON "InventoryMovementTracking"("company_id", "product_id", "serial_id");

CREATE TABLE IF NOT EXISTS "InventoryTrackingBalance" (
  "id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "factory_id" TEXT NOT NULL,
  "product_id" TEXT NOT NULL,
  "batch_id" TEXT,
  "serial_id" TEXT,
  "barcode" TEXT,
  "expiry_date" TIMESTAMP(3),
  "location_label" TEXT,
  "quantity" DECIMAL(15,2) NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InventoryTrackingBalance_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InventoryTrackingBalance_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "InventoryTrackingBalance_factory_id_fkey" FOREIGN KEY ("factory_id") REFERENCES "Factory"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "InventoryTrackingBalance_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "InventoryTrackingBalance_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "InventoryBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "InventoryTrackingBalance_serial_id_fkey" FOREIGN KEY ("serial_id") REFERENCES "InventorySerial"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "InventoryTrackingBalance_company_id_factory_id_product_id_batch_id_serial_id_barcode_location_label_key" ON "InventoryTrackingBalance"("company_id", "factory_id", "product_id", "batch_id", "serial_id", "barcode", "location_label");
CREATE INDEX IF NOT EXISTS "InventoryTrackingBalance_company_id_product_id_expiry_date_idx" ON "InventoryTrackingBalance"("company_id", "product_id", "expiry_date");
CREATE INDEX IF NOT EXISTS "InventoryTrackingBalance_company_id_factory_id_location_label_idx" ON "InventoryTrackingBalance"("company_id", "factory_id", "location_label");

CREATE TABLE IF NOT EXISTS "DeliveryChallan" (
  "id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "factory_id" TEXT NOT NULL,
  "client_id" TEXT,
  "order_id" TEXT,
  "sales_company_id" TEXT,
  "challan_no" TEXT NOT NULL,
  "kind" "DeliveryChallanKind" NOT NULL DEFAULT 'OUTWARD',
  "reason" "DeliveryChallanReason" NOT NULL DEFAULT 'SALE',
  "status" "DeliveryChallanStatus" NOT NULL DEFAULT 'DRAFT',
  "issue_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "place_of_supply_state" TEXT,
  "place_of_supply_code" TEXT,
  "notes" TEXT,
  "is_active" BOOLEAN NOT NULL DEFAULT TRUE,
  "created_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DeliveryChallan_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DeliveryChallan_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "DeliveryChallan_factory_id_fkey" FOREIGN KEY ("factory_id") REFERENCES "Factory"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "DeliveryChallan_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "DeliveryChallan_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "DeliveryChallan_sales_company_id_fkey" FOREIGN KEY ("sales_company_id") REFERENCES "SalesCompany"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "DeliveryChallan_company_id_challan_no_key" ON "DeliveryChallan"("company_id", "challan_no");
CREATE INDEX IF NOT EXISTS "DeliveryChallan_company_id_factory_id_issue_date_idx" ON "DeliveryChallan"("company_id", "factory_id", "issue_date");
CREATE INDEX IF NOT EXISTS "DeliveryChallan_company_id_status_idx" ON "DeliveryChallan"("company_id", "status");

CREATE TABLE IF NOT EXISTS "DeliveryChallanItem" (
  "id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "delivery_challan_id" TEXT NOT NULL,
  "product_id" TEXT NOT NULL,
  "quantity" DECIMAL(15,2) NOT NULL,
  "remarks" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DeliveryChallanItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DeliveryChallanItem_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "DeliveryChallanItem_delivery_challan_id_fkey" FOREIGN KEY ("delivery_challan_id") REFERENCES "DeliveryChallan"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "DeliveryChallanItem_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "DeliveryChallanItem_company_id_delivery_challan_id_idx" ON "DeliveryChallanItem"("company_id", "delivery_challan_id");
CREATE INDEX IF NOT EXISTS "DeliveryChallanItem_company_id_product_id_idx" ON "DeliveryChallanItem"("company_id", "product_id");

CREATE TABLE IF NOT EXISTS "PurchaseReceipt" (
  "id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "factory_id" TEXT NOT NULL,
  "purchase_id" TEXT NOT NULL,
  "receipt_no" TEXT NOT NULL,
  "status" "PurchaseReceiptStatus" NOT NULL DEFAULT 'DRAFT',
  "receipt_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "notes" TEXT,
  "created_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PurchaseReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PurchaseReceipt_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PurchaseReceipt_factory_id_fkey" FOREIGN KEY ("factory_id") REFERENCES "Factory"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PurchaseReceipt_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "Purchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "PurchaseReceipt_company_id_receipt_no_key" ON "PurchaseReceipt"("company_id", "receipt_no");
CREATE INDEX IF NOT EXISTS "PurchaseReceipt_company_id_purchase_id_receipt_date_idx" ON "PurchaseReceipt"("company_id", "purchase_id", "receipt_date");

CREATE TABLE IF NOT EXISTS "PurchaseReceiptItem" (
  "id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "purchase_receipt_id" TEXT NOT NULL,
  "purchase_item_id" TEXT,
  "product_id" TEXT,
  "inventory_movement_id" TEXT,
  "description" TEXT NOT NULL,
  "ordered_quantity" DECIMAL(15,2),
  "quantity" DECIMAL(15,2) NOT NULL,
  "accepted_quantity" DECIMAL(15,2) NOT NULL,
  "rejected_quantity" DECIMAL(15,2) NOT NULL DEFAULT 0,
  "unit_cost" DECIMAL(15,2),
  "location_label" TEXT,
  "notes" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PurchaseReceiptItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PurchaseReceiptItem_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PurchaseReceiptItem_purchase_receipt_id_fkey" FOREIGN KEY ("purchase_receipt_id") REFERENCES "PurchaseReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PurchaseReceiptItem_purchase_item_id_fkey" FOREIGN KEY ("purchase_item_id") REFERENCES "PurchaseItem"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "PurchaseReceiptItem_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "PurchaseReceiptItem_company_id_purchase_receipt_id_idx" ON "PurchaseReceiptItem"("company_id", "purchase_receipt_id");
CREATE INDEX IF NOT EXISTS "PurchaseReceiptItem_company_id_purchase_item_id_idx" ON "PurchaseReceiptItem"("company_id", "purchase_item_id");
CREATE INDEX IF NOT EXISTS "PurchaseReceiptItem_company_id_product_id_idx" ON "PurchaseReceiptItem"("company_id", "product_id");

CREATE TABLE IF NOT EXISTS "SupplierReturn" (
  "id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "factory_id" TEXT NOT NULL,
  "purchase_id" TEXT NOT NULL,
  "return_no" TEXT NOT NULL,
  "debit_note_no" TEXT,
  "status" "SupplierReturnStatus" NOT NULL DEFAULT 'DRAFT',
  "return_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reason_summary" TEXT,
  "notes" TEXT,
  "created_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SupplierReturn_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupplierReturn_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SupplierReturn_factory_id_fkey" FOREIGN KEY ("factory_id") REFERENCES "Factory"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SupplierReturn_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "Purchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "SupplierReturn_company_id_return_no_key" ON "SupplierReturn"("company_id", "return_no");
CREATE INDEX IF NOT EXISTS "SupplierReturn_company_id_purchase_id_return_date_idx" ON "SupplierReturn"("company_id", "purchase_id", "return_date");

CREATE TABLE IF NOT EXISTS "SupplierReturnItem" (
  "id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "supplier_return_id" TEXT NOT NULL,
  "purchase_item_id" TEXT,
  "product_id" TEXT,
  "inventory_movement_id" TEXT,
  "description" TEXT NOT NULL,
  "quantity" DECIMAL(15,2) NOT NULL,
  "unit_price" DECIMAL(15,2),
  "reason_code" TEXT,
  "reason_note" TEXT,
  "location_label" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SupplierReturnItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupplierReturnItem_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SupplierReturnItem_supplier_return_id_fkey" FOREIGN KEY ("supplier_return_id") REFERENCES "SupplierReturn"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SupplierReturnItem_purchase_item_id_fkey" FOREIGN KEY ("purchase_item_id") REFERENCES "PurchaseItem"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "SupplierReturnItem_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "SupplierReturnItem_company_id_supplier_return_id_idx" ON "SupplierReturnItem"("company_id", "supplier_return_id");
CREATE INDEX IF NOT EXISTS "SupplierReturnItem_company_id_purchase_item_id_idx" ON "SupplierReturnItem"("company_id", "purchase_item_id");
CREATE INDEX IF NOT EXISTS "SupplierReturnItem_company_id_product_id_idx" ON "SupplierReturnItem"("company_id", "product_id");

CREATE INDEX IF NOT EXISTS "Company_gst_registration_type_idx" ON "Company"("gst_registration_type");
CREATE INDEX IF NOT EXISTS "Product_company_id_tracking_mode_idx" ON "Product"("company_id", "tracking_mode");
CREATE INDEX IF NOT EXISTS "Order_company_id_sales_company_id_idx" ON "Order"("company_id", "sales_company_id");
CREATE INDEX IF NOT EXISTS "Invoice_company_id_reference_invoice_id_idx" ON "Invoice"("company_id", "reference_invoice_id");
CREATE INDEX IF NOT EXISTS "Purchase_company_id_factory_id_purchase_date_idx" ON "Purchase"("company_id", "factory_id", "purchase_date");
CREATE INDEX IF NOT EXISTS "Purchase_company_id_factory_id_status_idx" ON "Purchase"("company_id", "factory_id", "status");
CREATE INDEX IF NOT EXISTS "PurchaseItem_company_id_product_id_idx" ON "PurchaseItem"("company_id", "product_id");

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Product_tax_class_id_fkey'
  ) THEN
    ALTER TABLE "Product"
      ADD CONSTRAINT "Product_tax_class_id_fkey"
      FOREIGN KEY ("tax_class_id") REFERENCES "TaxClass"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Invoice_reference_invoice_id_fkey'
  ) THEN
    ALTER TABLE "Invoice"
      ADD CONSTRAINT "Invoice_reference_invoice_id_fkey"
      FOREIGN KEY ("reference_invoice_id") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PurchaseItem_product_id_fkey'
  ) THEN
    ALTER TABLE "PurchaseItem"
      ADD CONSTRAINT "PurchaseItem_product_id_fkey"
      FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
