// Permissive placeholder schema for the server Supabase client.
//
// The catalog/data branch will replace this with the real generated types
// (`supabase gen types typescript` → committed here). Until then this gives the
// untyped server queries concrete (Record-shaped) results so `tsc` is clean
// without inventing column types the schema doesn't yet pin down in TypeScript.
// Permissive `any`-valued rows: faithfully matches how the existing server
// routes were written (untyped client). Real generated types replace this later.
type Row = Record<string, any>;
type Table = { Row: Row; Insert: Row; Update: Row; Relationships: [] };
type Fn = { Args: Record<string, any>; Returns: any };

export type Database = {
  public: {
    Tables: {
      cultures: Table;
      occasion_types: Table;
      collections: Table;
      designs: Table;
      design_assets: Table;
      orders: Table;
      entitlements: Table;
      processed_events: Table;
      pending_emails: Table;
    };
    Views: Record<string, never>;
    Functions: {
      process_payment: Fn;
      revoke_payment: Fn;
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
