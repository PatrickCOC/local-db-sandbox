-- Synthetic schemas for the tests of the catalog scan. They belong to no application.
-- What the sandbox does not reproduce, several schemas with the same table name, a
-- type of a schema that is not read, and an empty schema.

create schema archive;
create schema lookup;
create schema empty_one;

create type lookup.color as enum ('red', 'green');
create domain positive_int as integer check (value > 0);

create table accounts (
  id integer primary key,
  handle text not null
);

-- The same name as archive.orders below.
create table orders (
  id integer primary key,
  account_id integer references accounts (id)
);

create table archive.orders (
  id integer primary key,
  account_id integer references public.accounts (id),
  closed_on date
);

create table palette (
  id integer primary key,
  color lookup.color not null default 'red',
  colors lookup.color[]
);

create table oddities (
  id integer primary key,
  spot point,
  during tsrange,
  amount positive_int,
  address inet,
  total integer generated always as (id * 2) stored,
  constraint oddities_no_overlap exclude using gist (during with &&)
);

create table bookings (
  id integer not null,
  starts timestamp not null,
  primary key (id, starts)
) partition by range (starts);
create table bookings_2026 partition of bookings for values from ('2026-01-01') to ('2027-01-01');

create view account_handles as select id, handle from accounts;

create function touch() returns trigger language plpgsql as $$ begin return new; end $$;
create trigger accounts_touch before update on accounts for each row execute function touch();

alter table accounts enable row level security;

-- A table that belongs to an extension, as extensions' own tables do.
create table extension_settings (id integer primary key, value text);
alter extension plpgsql add table extension_settings;

-- A table of another schema that uses an enumerated type of a third, and an index whose name public has too.
create table archive.labels (
  id integer primary key,
  color lookup.color not null default 'green'
);
create index by_account on orders (account_id);
create index by_account on archive.orders (account_id);
