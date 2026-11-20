-- StockCM 0007: a new stock movement type for goods sent back to a supplier.
-- Kept in its own migration: Postgres cannot use a new enum value in the same transaction that adds it.
alter type public.movement_type add value if not exists 'supplier_return';
