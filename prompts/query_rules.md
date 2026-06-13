# ArcGIS Query Notes

These rules help convert user requests into ArcGIS query parameters.

---

## Building WHERE Clauses

### Text Fields

Use case-insensitive comparisons.

Examples:

```sql
UPPER(City)=UPPER('Abu Dhabi')
UPPER(Portfolio)=UPPER('Seha')
```

Not equal:

```sql
UPPER(City)<>UPPER('Al Ain')
```

Contains:

```sql
UPPER(Property_Name) LIKE UPPER('%hospital%')
```

Multiple values:

```sql
Portfolio IN ('Seha','Miza')
```

Exclude values:

```sql
Portfolio NOT IN ('Seha','Miza')
```

---

### Numeric Fields

Do not use UPPER() on numeric fields.

Examples:

```sql
Plot_Area__sqm_ > 50000
Plot_Area__sqm_ < 100000
Plot_Area__sqm_ >= 1000
Plot_Area__sqm_ <= 5000
```

Range:

```sql
Plot_Area__sqm_ >= 1000
AND Plot_Area__sqm_ <= 5000
```

---

### Null Values

No owner:

```sql
Owner_Name IS NULL
```

Owner exists:

```sql
Owner_Name IS NOT NULL
```

---

### Multiple Filters

Combine filters using AND or OR.

Example:

```sql
UPPER(City)=UPPER('Abu Dhabi')
AND UPPER(Property_Status) LIKE UPPER('%Vacant%')
```

---

## Handling Negative Filters

Users often phrase exclusions differently.

Treat these the same way:

- not in Abu Dhabi
- outside Abu Dhabi
- excluding Abu Dhabi
- except Abu Dhabi
- other than Abu Dhabi

Example:

```sql
UPPER(City)<>UPPER('Abu Dhabi')
```

---

## Field Mapping

Use these fields when translating user language.

| User Term | Field |
|------------|------------|
| area | Plot_Area__sqm_ |
| plot area | Plot_Area__sqm_ |
| land size | Plot_Area__sqm_ |
| portfolio | Portfolio |
| company | Portfolio |
| entity | Portfolio |
| city | City |
| emirate | City |
| country | Country |
| status | Property_Status |
| operational | Property_Status |
| vacant | Property_Status |
| type | Property_Type |
| land | Property_Type |
| building | Property_Type |
| ownership | Ownership_Type |
| freehold | Ownership_Type |
| leasehold | Ownership_Type |
| industry | Industry |
| sector | Industry |
| owner name | Owner_Name |
| property id | Property_ID |

---

## Area Field

When the user says:

- area
- plot area
- land size
- largest plot
- smallest plot

Use:

```text
Plot_Area__sqm_
```

Do not use:

```text
Area
```

The `Area` field is a text zone label and should never be used for sorting or statistics.

---

## Sorting

Largest plots:

```text
order_by_fields="Plot_Area__sqm_ DESC"
```

Smallest plots:

```text
order_by_fields="Plot_Area__sqm_ ASC"
```

---

## Top-N Requests

Examples:

Top 10 largest plots:

```text
order_by_fields="Plot_Area__sqm_ DESC"
result_record_count=10
```

Largest plot:

```text
order_by_fields="Plot_Area__sqm_ DESC"
result_record_count=1
```

Bottom 20 smallest plots:

```text
order_by_fields="Plot_Area__sqm_ ASC"
result_record_count=20
```

---

## result_record_count

Only use `result_record_count` when returning a ranked list.

Examples:

- top 10 plots
- largest plot
- smallest 20 plots

Do not use it for normal searches.

Bad:

```text
show all vacant plots
result_record_count=100
```

Good:

```text
show all vacant plots
```

The service already handles the default limit.

---

## Count Queries

If the user asks:

- how many
- total number
- count

Use:

```text
return_count_only=true
```

Example:

```text
How many Seha plots are there?
```

---

## Follow-up After a Count

Example:

User:

```text
How many vacant plots are there?
```

Later:

```text
Show me those plots
```

Reuse the same filters from the count query.

Do not:

```text
return_count_only=true
```

Do not set:

```text
result_record_count
```

Use:

```text
return_geometry=true
```

and return the matching features.

---

## Statistics

Count:

```text
return_count_only=true
```

Total area:

```text
out_statistics='[
{
"statisticType":"sum",
"onStatisticField":"Plot_Area__sqm_",
"outStatisticFieldName":"TOTAL"
}
]'
```

Average area:

```text
out_statistics='[
{
"statisticType":"avg",
"onStatisticField":"Plot_Area__sqm_",
"outStatisticFieldName":"AVG_AREA"
}
]'
```

Minimum area:

```text
out_statistics='[
{
"statisticType":"min",
"onStatisticField":"Plot_Area__sqm_",
"outStatisticFieldName":"MIN_AREA"
}
]'
```

Maximum area:

```text
out_statistics='[
{
"statisticType":"max",
"onStatisticField":"Plot_Area__sqm_",
"outStatisticFieldName":"MAX_AREA"
}
]'
```

---

## Grouping

Example:

```text
group_by_fields="Portfolio"
```

Typically used with statistics.

Example:

"Show plot count by portfolio"

---

## Group-By and Statistics Follow-Ups

When the user asks for a breakdown or statistics after a filtered query, **always include the active WHERE clause** from the previous query.

Example:

Previous result:
> 128 plots under construction displayed on the map.

User asks:
> in which city

Build:

```text
where="UPPER(Property_Status) LIKE UPPER('%Under Construction%')"
group_by_fields="City"
out_statistics with count
```

Do **not** run a fresh query without the WHERE clause.

If you do, the statistics will count all plots across all statuses — not the filtered set — and the numbers will be wrong.

This also applies to:
- "how many in each city?" after a filtered result
- "break down by portfolio" after a status filter
- "group by industry" after any previous filter

Always use the same WHERE clause that produced the previous feature query result.

---

## Distinct Values

Example:

User:

```text
List all portfolios
```

Parameters:

```text
return_distinct_values=true
out_fields="Portfolio"
return_geometry=false
```

---

## Common Shortcuts

Vacant plots:

```sql
UPPER(Property_Status) LIKE UPPER('%Vacant%')
```

Operational plots:

```sql
UPPER(Property_Status) LIKE UPPER('%Operational%')
```

Freehold:

```sql
UPPER(Ownership_Type)=UPPER('Freehold')
```

Leasehold:

```sql
UPPER(Ownership_Type) LIKE UPPER('%Leasehold%')
```

Land plots:

```sql
UPPER(Property_Type)=UPPER('Land')
```

Healthcare plots:

```sql
UPPER(Industry) LIKE UPPER('%Healthcare%')
```

---

## Common Examples

Plots in Abu Dhabi:

```sql
UPPER(City)=UPPER('Abu Dhabi')
```

Plots not in Abu Dhabi:

```sql
UPPER(City)<>UPPER('Abu Dhabi')
```

Seha and Miza plots:

```sql
Portfolio IN ('Seha','Miza')
```

Operational Miza plots:

```sql
UPPER(Portfolio)=UPPER('Miza')
AND UPPER(Property_Status) LIKE UPPER('%Operational%')
```

Vacant freehold plots in Al Ain:

```sql
UPPER(City)=UPPER('Al Ain')
AND UPPER(Property_Status) LIKE UPPER('%Vacant%')
AND UPPER(Ownership_Type)=UPPER('Freehold')
```

Plots larger than 50,000 sqm:

```sql
Plot_Area__sqm_ > 50000
```

Plots between 1,000 and 5,000 sqm:

```sql
Plot_Area__sqm_ >= 1000
AND Plot_Area__sqm_ <= 5000
```

Plots with hospital in the name:

```sql
UPPER(Property_Name) LIKE UPPER('%hospital%')
```

Plots without an owner:

```sql
Owner_Name IS NULL
```