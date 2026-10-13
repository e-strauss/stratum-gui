import type { Plan } from "./types.ts";

export const optionLabels = {
  cse: "Common subexpressions", dataframe_ops: "Dataframe extraction",
  numeric_ops: "Numeric extraction", unroll_choices: "Choice unrolling",
  algebraic_rewrites: "Algebraic rewrites", semi_join_rewrite: "Semi-join promotion",
  propagate_schema: "Schema propagation",
};
export type OptimizerOptions = Record<keyof typeof optionLabels, boolean>;
export type Optimization = {
  status: "completed" | "failed"; plans: Plan[];
  error: { stage: string; type: string; message: string; traceback: string } | null;
  timings: { preparation: number; optimization: number; total: number };
  stdout: string; stderr: string;
};
export const stageLabels: Record<string, string> = {
  skrub: "Skrub input", conversion: "Logical conversion", frame_rewrite: "Dataframe extraction",
  numeric_rewrite: "Numeric extraction", op_cse: "Common subexpressions", unrolled: "Choice unrolling",
  algebraic_rewrite: "Algebraic rewrites", relational_rewrite: "Relational rewrites",
  logical: "Final logical plan", lowered: "Physical lowering", physical: "Physical plan",
  selected_physical: "Implementation selection", physical_impl: "Executable plan",
};

export type Example = { group: string; name: string; code: string; phase?: "physical"; selector?: "greedy" };
export const examples: Example[] = [
  { group: "Pipelines", name: "Filter & arithmetic", code: `import pandas as pd
import skrub

data = skrub.var("data", pd.DataFrame({
    "age": [25, 32, 48, 54],
    "income": [28000, 45000, 62000, 85000],
}))

filtered = data[data["income"] > 30000]
dag = filtered[["age", "income"]].assign(
    score=filtered["age"] * 2 + filtered["income"] / 1000
)
` },
  { group: "Pipelines", name: "Regression pipeline", code: `import pandas as pd
import skrub
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import Ridge

data = skrub.var("data", pd.DataFrame({
    "x": [1., 2., 3., 4., 5., 6.],
    "y": [2., 4., 5., 8., 9., 12.],
}))
X = data[["x"]].skb.mark_as_X()
y = data["y"].skb.mark_as_y()
scaled = X.skb.apply(StandardScaler())
dag = scaled.skb.apply(Ridge(), y=y)
` },
  { group: "Pipelines", name: "Estimator choices", code: `import pandas as pd
import skrub
from sklearn.linear_model import Ridge

data = skrub.var("data", pd.DataFrame({
    "x": [1., 2., 3., 4., 5., 6.],
    "y": [2., 4., 5., 8., 9., 12.],
}))
X = data[["x"]].skb.mark_as_X()
y = data["y"].skb.mark_as_y()
alpha = skrub.choose_from([0.1, 1.0, 10.0], name="alpha")
dag = X.skb.apply(Ridge(alpha=alpha), y=y)
` },
  { group: "Pipelines", name: "Complex feature map", code: `import pandas as pd
import skrub

# A small, messy order book; graph complexity comes from the expressions.
data = skrub.var("orders", pd.DataFrame({
    "quantity": [2., 12., None, 1., 4., 8.],
    "unit_price": [49.5, 120., 15., None, 80., 22.5],
    "unit_cost": [20., 75., 5., 10., 45., 12.],
    "discount": [0.10, 0.25, None, 0., 1.20, -0.10],
    "customer": [" Alice Smith ", "BOB", None, " Chandra ", "Dora", " Emil "],
    "email": [" ALICE@EXAMPLE.COM ", "bob@shop.org", None,
              "chandra@example.com", "dora@shop.org", "emil@example.com"],
    "product": [" SKU-001 ", "sku-204", " SKU-015", "sku-999 ", "SKU-080", "sku-008"],
    "country": [" de ", "FR", "us", None, "DE", " fr"],
    "ordered_at": ["2026-01-31 09:15:00", "2026-02-14 18:45:00",
                   "invalid", "2026-03-01 08:00:00",
                   "2026-06-30 12:30:00", "2026-12-25 16:00:00"],
}))

# Reuse intermediates across many branches of the Skrub DAG.
quantity = data["quantity"].fillna(0).clip(lower=0).astype("float32")
price = data["unit_price"].fillna(0).clip(lower=0)
discount = data["discount"].fillna(0).clip(lower=0, upper=1)
gross = quantity * price
net = gross * (1 - discount)
margin = net - quantity * data["unit_cost"]
customer = data["customer"].fillna("unknown").str.strip().str.lower()
email = data["email"].fillna("").str.strip().str.lower()
product = data["product"].str.strip().str.upper()
country = data["country"].fillna("unknown").str.strip().str.upper()
ordered = data["ordered_at"].skb.apply_func(
    pd.to_datetime, format="%Y-%m-%d %H:%M:%S", errors="coerce"
)

# One assign is the folding boundary: all branches become ColumnExpr trees
# inside one Stratum AssignMapOp (the MapOp family), fed only by the source.
# Compare "Skrub input" / "Logical conversion" with "Dataframe extraction".
dag = data.assign(
    # Missing values, casts, clipping, arithmetic and shared subexpressions.
    quantity_clean=quantity,
    price_clean=price,
    discount_clean=discount,
    gross_amount=gross,
    net_amount=net,
    tax_amount=net * 0.19,
    margin_amount=margin,
    margin_ratio=margin / net.clip(lower=1),
    amount_per_item=net / quantity.clip(lower=1),
    quantity_bucket=quantity // 5,
    price_squared=price ** 2,
    # Predicates, membership, negation and conditional replacement.
    has_quantity=data["quantity"].notna(),
    discount_missing=~data["discount"].notna(),
    high_value=(net >= 100) & (quantity > 0),
    promo_order=(discount > 0) | (quantity >= 10),
    positive_margin=margin.where(margin > 0, 0),
    # String normalization, lengths, regex counts and prefix/suffix tests.
    customer_clean=customer,
    customer_length=customer.str.len(),
    email_clean=email,
    email_length=email.str.len(),
    email_at_count=email.str.count("@"),
    is_example_email=email.str.endswith("@example.com"),
    product_clean=product,
    product_length=product.str.len(),
    product_digit_count=product.str.count("[0-9]"),
    is_sku=product.str.startswith("SKU-"),
    country_code=country,
    priority_market=country.isin(["DE", "FR"]),
    # Shared datetime parsing, calendar fields and time-based predicates.
    ordered_at_parsed=ordered,
    order_year=ordered.dt.year,
    order_month=ordered.dt.month,
    order_day=ordered.dt.day,
    order_hour=ordered.dt.hour,
    order_quarter=ordered.dt.quarter,
    order_day_of_year=ordered.dt.dayofyear,
    is_month_end=ordered.dt.is_month_end,
    in_business_hours=(ordered.dt.hour >= 9) & (ordered.dt.hour < 17),
    feature_version=1,
)
` },
  { group: "Frame operators", name: "Projection, rename & drop", code: `import pandas as pd
import skrub

orders = skrub.var("orders", pd.DataFrame({
    "order_id": [1, 2, 3, 4, 5, 6],
    "customer": ["ann", "bob", "ann", "cid", None, "bob"],
    "amount": [20.0, 35.5, None, 12.0, 50.0, 35.5],
}))

# Literal column selections become ColumnProjectionOps, rename a MetadataOp
# and drop a DropOp. Compare "Logical conversion" with "Dataframe extraction".
picked = orders[["order_id", "customer", "amount"]]
renamed = picked.rename(columns={"amount": "total"})
dag = renamed.drop(columns=["order_id"])
` },
  { group: "Frame operators", name: "Row selections", code: `import pandas as pd
import skrub

orders = skrub.var("orders", pd.DataFrame({
    "order_id": [1, 2, 3, 4, 5, 6],
    "customer": ["ann", "bob", "ann", "cid", None, "bob"],
    "amount": [20.0, 35.5, None, 12.0, 50.0, 35.5],
}))

# A boolean mask and the row-restricting frame methods all become SelectionOps
# (MASK, DROPNA, DROP_DUPLICATES, HEAD), each with its kind in the label.
large = orders[orders["amount"] > 15]
dag = large.dropna().drop_duplicates(subset=["customer"]).head(3)
` },
  { group: "Frame operators", name: "Sorting", code: `import pandas as pd
import skrub

orders = skrub.var("orders", pd.DataFrame({
    "order_id": [1, 2, 3, 4, 5, 6],
    "customer": ["ann", "bob", "ann", "cid", None, "bob"],
    "amount": [20.0, 35.5, None, 12.0, 50.0, 35.5],
}))

# sort_values with literal keys becomes a SortOp carrying keys and directions.
dag = orders.sort_values(by=["customer", "amount"], ascending=[True, False])
` },
  { group: "Frame operators", name: "Group-by aggregation", code: `import pandas as pd
import skrub

orders = skrub.var("orders", pd.DataFrame({
    "order_id": [1, 2, 3, 4, 5, 6],
    "customer": ["ann", "bob", "ann", "cid", None, "bob"],
    "amount": [20.0, 35.5, None, 12.0, 50.0, 35.5],
}))

# The groupby call and its aggregation fuse into a single AggregateOp.
dag = orders.groupby("customer").agg(
    total=("amount", "sum"),
    orders=("order_id", "count"),
)
` },
  { group: "Frame operators", name: "Value counts", code: `import pandas as pd
import skrub

orders = skrub.var("orders", pd.DataFrame({
    "order_id": [1, 2, 3, 4, 5, 6],
    "customer": ["ann", "bob", "ann", "cid", None, "bob"],
    "amount": [20.0, 35.5, None, 12.0, 50.0, 35.5],
}))

# value_counts expands into a grouped count AggregateOp followed by a SortOp,
# reproducing pandas' order of equally frequent values.
dag = orders["customer"].value_counts()
` },
  { group: "Frame operators", name: "Joins", code: `import pandas as pd
import skrub

orders = skrub.var("orders", pd.DataFrame({
    "order_id": [1, 2, 3, 4, 5, 6],
    "customer": ["ann", "bob", "ann", "cid", None, "bob"],
    "amount": [20.0, 35.5, None, 12.0, 50.0, 35.5],
}))

customers = skrub.var("customers", pd.DataFrame({
    "customer": ["ann", "bob", "cid"],
    "country": ["DE", "FR", "US"],
}))

# merge becomes a JoinOp with normalized keys, join type and suffixes.
dag = orders.merge(customers, on="customer", how="left")
` },
  { group: "Frame operators", name: "Concatenation", code: `import pandas as pd
import skrub

orders = skrub.var("orders", pd.DataFrame({
    "order_id": [1, 2, 3, 4, 5, 6],
    "customer": ["ann", "bob", "ann", "cid", None, "bob"],
    "amount": [20.0, 35.5, None, 12.0, 50.0, 35.5],
}))

extra = skrub.var("extra", pd.DataFrame({"priority": [1, 0, 0, 1, 0, 1]}))

# skb.concat becomes a ConcatOp over both frames.
dag = orders.skb.concat([extra], axis=1)
` },
  { group: "Frame operators", name: "Column methods", code: `import pandas as pd
import skrub

orders = skrub.var("orders", pd.DataFrame({
    "order_id": [1, 2, 3, 4, 5, 6],
    "customer": ["ann", "bob", "ann", "cid", None, "bob"],
    "amount": [20.0, 35.5, None, 12.0, 50.0, 35.5],
}))

# fillna, clip, astype, isin, where and the comparison methods each become
# column operators; inside assign they fold into one AssignMapOp.
amount = orders["amount"].fillna(0).clip(lower=0, upper=40).astype("float32")
dag = orders.assign(
    amount_clean=amount,
    is_regular=orders["customer"].isin(["ann", "bob"]),
    big=amount.gt(30),
    capped=amount.where(amount < 30, 30),
)
` },
  { group: "Frame operators", name: "Strings & datetimes", code: `import pandas as pd
import skrub

events = skrub.var("events", pd.DataFrame({
    "user": [" Ann ", "BOB", "cid "],
    "ts": ["2026-01-31 09:15:00", "2026-02-14 18:45:00", "2026-03-01 08:00:00"],
}))

# .str.<method> fuses into StringMethodOps, pd.to_datetime becomes a
# DatetimeConversionOp and .dt.<field> a GetAttrProjectionOp.
user = events["user"].str.strip().str.lower()
ts = events["ts"].skb.apply_func(pd.to_datetime, format="%Y-%m-%d %H:%M:%S")
dag = events.assign(user=user, month=ts.dt.month, hour=ts.dt.hour)
` },
  { group: "Relational rewrites", name: "isin → semi join", code: `import pandas as pd
import skrub

orders = skrub.var("orders", pd.DataFrame({
    "order_id": [1, 2, 3, 4, 5, 6],
    "customer": ["ann", "bob", "ann", "cid", None, "bob"],
    "amount": [20.0, 35.5, None, 12.0, 50.0, 35.5],
}))

vip = skrub.var("vip", pd.DataFrame({"customer": ["ann", "cid"]}))

# isin against another relation's column is a subquery: the relational rewrite
# turns the SelectionOp into a semi JoinOp (toggle "Semi-join promotion").
dag = orders[orders["customer"].isin(vip["customer"])]
` },
  { group: "Relational rewrites", name: "~isin → anti join", code: `import pandas as pd
import skrub

orders = skrub.var("orders", pd.DataFrame({
    "order_id": [1, 2, 3, 4, 5, 6],
    "customer": ["ann", "bob", "ann", "cid", None, "bob"],
    "amount": [20.0, 35.5, None, 12.0, 50.0, 35.5],
}))

blocked = skrub.var("blocked", pd.DataFrame({"customer": ["bob"]}))

# A negated membership test against a relation becomes an anti JoinOp.
dag = orders[~orders["customer"].isin(blocked["customer"])]
` },
  { group: "Relational rewrites", name: "isin literal stays a filter", code: `import pandas as pd
import skrub

orders = skrub.var("orders", pd.DataFrame({
    "order_id": [1, 2, 3, 4, 5, 6],
    "customer": ["ann", "bob", "ann", "cid", None, "bob"],
    "amount": [20.0, 35.5, None, 12.0, 50.0, 35.5],
}))

# Against a literal list, isin is just a predicate: it stays a SelectionOp.
# Compare with "isin → semi join".
dag = orders[orders["customer"].isin(["ann", "cid"])]
` },
  { group: "Relational rewrites", name: "Frequent keys → semi join", code: `import pandas as pd
import skrub

orders = skrub.var("orders", pd.DataFrame({
    "order_id": [1, 2, 3, 4, 5, 6],
    "customer": ["ann", "bob", "ann", "cid", None, "bob"],
    "amount": [20.0, 35.5, None, 12.0, 50.0, 35.5],
}))

# Keep only customers with at least two orders. The value_counts / index cone
# is replaced by a grouped count, a filter and GroupKeysOp, and the isin by a
# semi join; both reads of "orders" share one scan.
customer = orders["customer"]
counts = customer.value_counts()
frequent = counts[counts >= 2].index
dag = orders[customer.isin(frequent)].reset_index(drop=True)
` },
  { group: "Relational rewrites", name: "Projection pushup", code: `import pandas as pd
import skrub

orders = skrub.var("orders", pd.DataFrame({
    "order_id": [1, 2, 3, 4, 5, 6],
    "customer": ["ann", "bob", "ann", "cid", None, "bob"],
    "amount": [20.0, -35.5, None, 12.0, 50.0, 35.5],
}))

# The assign reads "amount", a column the projection drops. Before the rewrite
# the map takes it as a second input; the pushup runs the map on "orders" and
# projects afterwards, so "amount" is a plain column of one frame.
dag = orders[["order_id", "customer"]].assign(amount_eur=orders["amount"] * 0.92)
` },
  { group: "Relational rewrites", name: "Projection pushup over drop", code: `import pandas as pd
import skrub

orders = skrub.var("orders", pd.DataFrame({
    "order_id": [1, 2, 3, 4, 5, 6],
    "customer": ["ann", "bob", "ann", "cid", None, "bob"],
    "amount": [20.0, -35.5, None, 12.0, 50.0, 35.5],
}))

# The same rewrite for a column drop: the map runs first, the drop after it.
dag = orders.drop(columns=["amount"]).assign(amount_eur=orders["amount"] * 0.92)
` },
  { group: "Algebraic rewrites", name: "Inverse functions", code: `import numpy as np
import pandas as pd
import skrub

data = skrub.var("data", pd.DataFrame({"x": [1., 2., 3.], "y": [4., 5., 6.]}))
X = data[["x"]]

# np.log(np.exp(x)) and np.expm1(np.log1p(x)) cancel out under
# "Algebraic rewrites" (see "Numeric extraction" for the NumericOps).
a = X.skb.apply_func(np.exp).skb.apply_func(np.log)
dag = a.skb.apply_func(np.log1p).skb.apply_func(np.expm1) * 2
` },
  { group: "Algebraic rewrites", name: "Identities", code: `import numpy as np
import pandas as pd
import skrub

data = skrub.var("data", pd.DataFrame({"x": [1., 2., 3.], "y": [4., 5., 6.]}))
X = data[["x"]]

# x * 1, x + 0 and x / 1 are identity operations and disappear.
dag = ((X * 1) + 0) / 1
` },
  { group: "Algebraic rewrites", name: "sqrt(x · x) → abs", code: `import numpy as np
import pandas as pd
import skrub

data = skrub.var("data", pd.DataFrame({"x": [1., 2., 3.], "y": [4., 5., 6.]}))
X = data[["x"]]

# x * x folds into square(x), then sqrt(square(x)) into abs(x).
dag = (X * X).skb.apply_func(np.sqrt)
` },
  { group: "Algebraic rewrites", name: "log(sum(exp)) stabilized", code: `import numpy as np
import pandas as pd
import skrub

data = skrub.var("data", pd.DataFrame({"x": [1., 2., 3.], "y": [4., 5., 6.]}))
X = data[["x"]]

# The unstable log-sum-exp chain is replaced by a stable logsumexp.
dag = X.skb.apply_func(np.exp).skb.apply_func(np.sum).skb.apply_func(np.log)
` },
  { group: "Frame libraries", name: "Default selector: all pandas", phase: "physical", code: `import pandas as pd
import skrub

orders = skrub.var("orders", pd.DataFrame({
    "order_id": [1, 2, 3, 4, 5, 6],
    "customer": ["ann", "bob", "ann", "cid", None, "bob"],
    "sku": ["A-1.0", "B-2", "A-1.0", "C-3.0", "B-2", "D-4"],
    "amount": [20.0, -35.5, None, 12.0, 50.0, 35.5],
    "ordered": pd.to_datetime(["2026-01-31", "2026-02-14", "2026-02-28",
                               "2026-03-01", "2026-06-30", "2026-12-25"]),
}))

# Physical planning gives every frame edge a library. The default selector binds
# every operator to pandas. Load "Greedy: all polars" next for the same pipeline.
dag = orders.assign(double=orders["amount"] * 2)
` },
  { group: "Frame libraries", name: "Greedy: all polars", phase: "physical", selector: "greedy", code: `import pandas as pd
import skrub

orders = skrub.var("orders", pd.DataFrame({
    "order_id": [1, 2, 3, 4, 5, 6],
    "customer": ["ann", "bob", "ann", "cid", None, "bob"],
    "sku": ["A-1.0", "B-2", "A-1.0", "C-3.0", "B-2", "D-4"],
    "amount": [20.0, -35.5, None, 12.0, 50.0, 35.5],
    "ordered": pd.to_datetime(["2026-01-31", "2026-02-14", "2026-02-28",
                               "2026-03-01", "2026-06-30", "2026-12-25"]),
}))

# The same pipeline under the greedy selector: source and map both run on
# polars, and no conversion is needed (see "Executable plan").
dag = orders.assign(double=orders["amount"] * 2)
` },
  { group: "Frame libraries", name: "pandas call between polars ops", phase: "physical", selector: "greedy", code: `import pandas as pd
import skrub

orders = skrub.var("orders", pd.DataFrame({
    "order_id": [1, 2, 3, 4, 5, 6],
    "customer": ["ann", "bob", "ann", "cid", None, "bob"],
    "sku": ["A-1.0", "B-2", "A-1.0", "C-3.0", "B-2", "D-4"],
    "amount": [20.0, -35.5, None, 12.0, 50.0, 35.5],
    "ordered": pd.to_datetime(["2026-01-31", "2026-02-14", "2026-02-28",
                               "2026-03-01", "2026-06-30", "2026-12-25"]),
}))

# where without other only runs on pandas, so selection inserts explicit
# ConversionOps around it: polars -> pandas into the call, pandas -> polars out.
amount = orders["amount"]
dag = orders.assign(positive=amount.where(amount > 0))
` },
  { group: "Frame libraries", name: "One conversion per producer", phase: "physical", selector: "greedy", code: `import pandas as pd
import skrub

orders = skrub.var("orders", pd.DataFrame({
    "order_id": [1, 2, 3, 4, 5, 6],
    "customer": ["ann", "bob", "ann", "cid", None, "bob"],
    "sku": ["A-1.0", "B-2", "A-1.0", "C-3.0", "B-2", "D-4"],
    "amount": [20.0, -35.5, None, 12.0, 50.0, 35.5],
    "ordered": pd.to_datetime(["2026-01-31", "2026-02-14", "2026-02-28",
                               "2026-03-01", "2026-06-30", "2026-12-25"]),
}))

# where and mask both need pandas. The projection is converted once and the
# conversion feeds every pandas consumer.
amount = orders["amount"]
dag = orders.assign(positive=amount.where(amount > 0), negative=amount.mask(amount > 0))
` },
  { group: "Polars translation", name: "Portable regex stays polars", phase: "physical", selector: "greedy", code: `import pandas as pd
import skrub

orders = skrub.var("orders", pd.DataFrame({
    "order_id": [1, 2, 3, 4, 5, 6],
    "customer": ["ann", "bob", "ann", "cid", None, "bob"],
    "sku": ["A-1.0", "B-2", "A-1.0", "C-3.0", "B-2", "D-4"],
    "amount": [20.0, -35.5, None, 12.0, 50.0, 35.5],
    "ordered": pd.to_datetime(["2026-01-31", "2026-02-14", "2026-02-28",
                               "2026-03-01", "2026-06-30", "2026-12-25"]),
}))

# A plain regex replace has an exact polars translation, so the map runs on
# polars without any conversion.
dag = orders.assign(sku=orders["sku"].str.replace("[.]0$", "", regex=True))
` },
  { group: "Polars translation", name: "Unportable regex: map on pandas", phase: "physical", selector: "greedy", code: `import pandas as pd
import skrub

orders = skrub.var("orders", pd.DataFrame({
    "order_id": [1, 2, 3, 4, 5, 6],
    "customer": ["ann", "bob", "ann", "cid", None, "bob"],
    "sku": ["A-1.0", "B-2", "A-1.0", "C-3.0", "B-2", "D-4"],
    "amount": [20.0, -35.5, None, 12.0, 50.0, 35.5],
    "ordered": pd.to_datetime(["2026-01-31", "2026-02-14", "2026-02-28",
                               "2026-03-01", "2026-06-30", "2026-12-25"]),
}))

# Lookarounds are not supported by polars' regex engine. The expression reports
# it at planning time, and the whole map falls back to pandas behind one
# conversion of the source. Compare with "Portable regex stays polars".
dag = orders.assign(sku=orders["sku"].str.replace("-(?=[0-9])", " #", regex=True))
` },
  { group: "Polars translation", name: "Unportable string method", phase: "physical", selector: "greedy", code: `import pandas as pd
import skrub

orders = skrub.var("orders", pd.DataFrame({
    "order_id": [1, 2, 3, 4, 5, 6],
    "customer": ["ann", "bob", "ann", "cid", None, "bob"],
    "sku": ["A-1.0", "B-2", "A-1.0", "C-3.0", "B-2", "D-4"],
    "amount": [20.0, -35.5, None, 12.0, 50.0, 35.5],
    "ordered": pd.to_datetime(["2026-01-31", "2026-02-14", "2026-02-28",
                               "2026-03-01", "2026-06-30", "2026-12-25"]),
}))

# Outside a map, the same replace is its own StringMethodOp: the projection
# stays on polars and only the column is converted for the pandas call.
dag = orders["sku"].str.replace("-(?=[0-9])", " #", regex=True)
` },
  { group: "Polars translation", name: "drop: columns polars, rows pandas", phase: "physical", selector: "greedy", code: `import pandas as pd
import skrub

orders = skrub.var("orders", pd.DataFrame({
    "order_id": [1, 2, 3, 4, 5, 6],
    "customer": ["ann", "bob", "ann", "cid", None, "bob"],
    "sku": ["A-1.0", "B-2", "A-1.0", "C-3.0", "B-2", "D-4"],
    "amount": [20.0, -35.5, None, 12.0, 50.0, 35.5],
    "ordered": pd.to_datetime(["2026-01-31", "2026-02-14", "2026-02-28",
                               "2026-03-01", "2026-06-30", "2026-12-25"]),
}))

# Dropping columns translates exactly to polars. Dropping rows by label needs
# pandas' index, so the plan converts between the two drops.
dag = orders.drop(columns=["sku"]).drop(index=[1, 3])
` },
  { group: "Polars translation", name: "pandas-only constant", phase: "physical", selector: "greedy", code: `import pandas as pd
import skrub

orders = skrub.var("orders", pd.DataFrame({
    "order_id": [1, 2, 3, 4, 5, 6],
    "customer": ["ann", "bob", "ann", "cid", None, "bob"],
    "sku": ["A-1.0", "B-2", "A-1.0", "C-3.0", "B-2", "D-4"],
    "amount": [20.0, -35.5, None, 12.0, 50.0, 35.5],
    "ordered": pd.to_datetime(["2026-01-31", "2026-02-14", "2026-02-28",
                               "2026-03-01", "2026-06-30", "2026-12-25"]),
}))

# pd.DateOffset has no polars equivalent, so the map runs on pandas.
# Compare with "Duration stays polars".
dag = orders.assign(renewal=orders["ordered"] + pd.DateOffset(years=1))
` },
  { group: "Polars translation", name: "Duration stays polars", phase: "physical", selector: "greedy", code: `import datetime
import pandas as pd
import skrub

orders = skrub.var("orders", pd.DataFrame({
    "order_id": [1, 2, 3, 4, 5, 6],
    "customer": ["ann", "bob", "ann", "cid", None, "bob"],
    "sku": ["A-1.0", "B-2", "A-1.0", "C-3.0", "B-2", "D-4"],
    "amount": [20.0, -35.5, None, 12.0, 50.0, 35.5],
    "ordered": pd.to_datetime(["2026-01-31", "2026-02-14", "2026-02-28",
                               "2026-03-01", "2026-06-30", "2026-12-25"]),
}))

# A plain timedelta is a polars duration: the map stays on polars.
dag = orders.assign(due=orders["ordered"] + datetime.timedelta(days=14))
` },
  { group: "Index semantics", name: "Same rows stay polars", phase: "physical", selector: "greedy", code: `import pandas as pd
import skrub

orders = skrub.var("orders", pd.DataFrame({
    "order_id": [1, 2, 3, 4, 5, 6],
    "customer": ["ann", "bob", "ann", "cid", None, "bob"],
    "sku": ["A-1.0", "B-2", "A-1.0", "C-3.0", "B-2", "D-4"],
    "amount": [20.0, -35.5, None, 12.0, 50.0, 35.5],
    "ordered": pd.to_datetime(["2026-01-31", "2026-02-14", "2026-02-28",
                               "2026-03-01", "2026-06-30", "2026-12-25"]),
}))

# The filtered frame and its columns hold the same rows in the same order, so
# pairing them by position (polars) equals aligning by label (pandas).
large = orders[orders["order_id"] > 2]
dag = large.assign(double=large["amount"] * 2, name=large["customer"].str.upper())
` },
  { group: "Index semantics", name: "Index labels keep pandas", phase: "physical", selector: "greedy", code: `import pandas as pd
import skrub

orders = skrub.var("orders", pd.DataFrame({
    "order_id": [1, 2, 3, 4, 5, 6],
    "customer": ["ann", "bob", "ann", "cid", None, "bob"],
    "sku": ["A-1.0", "B-2", "A-1.0", "C-3.0", "B-2", "D-4"],
    "amount": [20.0, -35.5, None, 12.0, 50.0, 35.5],
    "ordered": pd.to_datetime(["2026-01-31", "2026-02-14", "2026-02-28",
                               "2026-03-01", "2026-06-30", "2026-12-25"]),
}))

# The filter leaves labels 0, 3, 4 and 5, and .index reads them. A
# polars -> pandas conversion would renumber them 0..3, so the filter falls
# back to pandas.
large = orders[orders["amount"] > 0]
dag = large.assign(row=large.index)
` },
  { group: "Index semantics", name: "Label alignment keeps pandas", phase: "physical", selector: "greedy", code: `import pandas as pd
import skrub

orders = skrub.var("orders", pd.DataFrame({
    "order_id": [1, 2, 3, 4, 5, 6],
    "customer": ["ann", "bob", "ann", "cid", None, "bob"],
    "sku": ["A-1.0", "B-2", "A-1.0", "C-3.0", "B-2", "D-4"],
    "amount": [20.0, -35.5, None, 12.0, 50.0, 35.5],
    "ordered": pd.to_datetime(["2026-01-31", "2026-02-14", "2026-02-28",
                               "2026-03-01", "2026-06-30", "2026-12-25"]),
}))

# pandas aligns the filtered column on the frame's labels (NaN elsewhere);
# polars would pair rows by position. The rows differ, so the map stays on pandas.
positive = orders["amount"][orders["amount"] > 0]
dag = orders.assign(positive=positive)
` },
  { group: "Index semantics", name: "Group labels keep pandas", phase: "physical", selector: "greedy", code: `import pandas as pd
import skrub

orders = skrub.var("orders", pd.DataFrame({
    "order_id": [1, 2, 3, 4, 5, 6],
    "customer": ["ann", "bob", "ann", "cid", None, "bob"],
    "sku": ["A-1.0", "B-2", "A-1.0", "C-3.0", "B-2", "D-4"],
    "amount": [20.0, -35.5, None, 12.0, 50.0, 35.5],
    "ordered": pd.to_datetime(["2026-01-31", "2026-02-14", "2026-02-28",
                               "2026-03-01", "2026-06-30", "2026-12-25"]),
}))

# The grouped result is labelled by customer, and reset_index turns those labels
# into a column. polars has no labels to give back, so the aggregation runs on
# pandas. Without reset_index it stays on polars.
dag = orders.groupby("customer").agg(total=("amount", "sum")).reset_index()
` },
  { group: "Index semantics", name: "Renumbered rows stay polars", phase: "physical", selector: "greedy", code: `import pandas as pd
import skrub

orders = skrub.var("orders", pd.DataFrame({
    "order_id": [1, 2, 3, 4, 5, 6],
    "customer": ["ann", "bob", "ann", "cid", None, "bob"],
    "sku": ["A-1.0", "B-2", "A-1.0", "C-3.0", "B-2", "D-4"],
    "amount": [20.0, -35.5, None, 12.0, 50.0, 35.5],
    "ordered": pd.to_datetime(["2026-01-31", "2026-02-14", "2026-02-28",
                               "2026-03-01", "2026-06-30", "2026-12-25"]),
}))

# After reset_index(drop=True) the pandas index is a fresh 0..n-1 again, which
# is exactly what polars' positional rows give: everything stays on polars.
dag = orders.sort_values("amount").reset_index(drop=True).assign(rank=1)
` },
];
export const exampleGroups = [...new Set(examples.map(example => example.group))];
