-- StockCM 0020: give a barcode to a product that has none (so labels can be printed for unlabelled goods).
-- Products are insert-only in the upload function; this adds ONE narrow operation: set the barcode when it is empty.
-- It runs under the caller's row-level security (needs the right to edit products); a clash with another product's barcode
-- is refused by the existing unique index.
do $$
declare def text;
begin
  def := pg_get_functiondef('public.sync_push(uuid, jsonb)'::regprocedure);
  if position('product_barcode' in def) = 0 then
    def := replace(def, E'    else\n      raise exception ''unknown table %'', t using errcode = ''22023'';',
$p$    elsif t = 'product_barcode' then
      -- a barcode given later to a product that had none (labels for unlabelled goods); products themselves are otherwise insert-only
      update public.products set barcode = nullif(trim(pl->>'barcode'), '')
       where id = (pl->>'id')::uuid and tenant_id = (pl->>'tenant_id')::uuid and barcode is null;
      get diagnostics n = row_count;
      if n <> 1 then raise exception 'product not found, or it already has a barcode' using errcode = '23514'; end if;
    else
      raise exception 'unknown table %', t using errcode = '22023';$p$);
    if position('product_barcode' in def) = 0 then raise exception 'could not extend sync_push'; end if;
    execute def;
  end if;
end $$;
revoke all on function public.sync_push(uuid, jsonb) from public, anon;
grant execute on function public.sync_push(uuid, jsonb) to authenticated;
