# Skill: Portfolio Report

When the user asks for a "portfolio report", "portfolio summary", or "portfolio breakdown", execute the following three queries in sequence and merge the results into a single report table.

## Step 1 — Total plots per portfolio

```python
query_layer(
    where="1=1",
    out_statistics=[{"statisticType": "count", "onStatisticField": "OBJECTID", "outStatisticFieldName": "Total_Plots"}],
    group_by_fields="Portfolio",
    order_by_fields="Total_Plots DESC"
)
```

## Step 2 — Vacant plots per portfolio

```python
query_layer(
    where="UPPER(Property_Status) LIKE UPPER('%Vacant%')",
    out_statistics=[{"statisticType": "count", "onStatisticField": "OBJECTID", "outStatisticFieldName": "Vacant_Plots"}],
    group_by_fields="Portfolio"
)
```

## Step 3 — Operational plots per portfolio

```python
query_layer(
    where="UPPER(Property_Status) LIKE UPPER('%Operational%')",
    out_statistics=[{"statisticType": "count", "onStatisticField": "OBJECTID", "outStatisticFieldName": "Operational_Plots"}],
    group_by_fields="Portfolio"
)
```

## Output Format

After running all three queries, merge the results by Portfolio name and present as a markdown table:

| Portfolio | Total Plots | Vacant | Operational |
|-----------|-------------|--------|-------------|
| ...       | ...         | ...    | ...         |

- Sort by Total Plots descending
- If a portfolio has no vacant or operational plots, show 0
- Add a totals row at the bottom
- Keep the response concise — table only, with a one-line summary above it
