# Numeric and timestamp ranges

`documentFilter.numberRange(select, bounds)` compares finite numbers.
`documentFilter.timeRange(select, bounds)` compares instants at millisecond
precision. Both return predicates and compose with `documentFilter.and`,
`or` and `not`. For example:

```js
const matches = documentFilter.and(
  documentFilter.timeRange(row => row.created, {
    gte: "2024-02-29T00:00:00Z", lt: "2024-03-01T00:00:00Z",
  }),
  documentFilter.numberRange(row => row.height, { gt: 4, lte: 10 }),
);
const selected = rows.filter(matches);
```

Specify at least one of `gt`, `gte`, `lt`, `lte` and at most one bound
at each end. Lower and upper bounds may coincide. An exclusive endpoint then
makes the range empty. Reversed bounds raise an error. Missing and null fields sort before all concrete values. For example,
`{ lt: 0 }` includes both, while `{ gte: 0 }` excludes both. With a null
bound, `{ lt: null }` matches nothing, `{ lte: null }` matches only missing
or null fields, `{ gt: null }` matches only concrete values, and
`{ gte: null }` includes both. Undefined bounds and malformed values raise an
error. The reference documents numeric comparisons of datetimes in milliseconds.
[Turbopuffer filter semantics](https://turbopuffer.com/docs/query#filtering-parameters)

An instant can be an integer Unix timestamp in milliseconds within JavaScript's
Date range, or a four-digit calendar year and timestamp of the form
`YYYY-MM-DDTHH:mm:ss[.sss]Z` or one with an explicit `±HH:mm` offset.
Fractional seconds may contain one to three digits. The date must exist;
hours run from 00 to 23, minutes and seconds from 00 to 59.
Local times, dates without times, leap seconds, `-00:00`, Date objects and
sub-millisecond strings raise an error. These predicates compare
already-fetched values. Attribute values can come from opted-in payloads and
numeric instants can come from direct metrics when the schema uses milliseconds.
