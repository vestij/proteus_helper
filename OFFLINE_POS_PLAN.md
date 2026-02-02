# Emergency POS Enhancement Plan

## Overview
This plan covers 7 new features for the Emergency/Offline POS module using existing Proteus webservices.

---

## Existing APIs Available

| Feature | Endpoint | Action |
|---------|----------|--------|
| Customer Search | `customers_json.cfm` | `getCustomers` (matchpartial=1) |
| ID Verification | `customers_json.cfm` | `lookupLicense` |
| Employee List | `staff2_json.cfm` | `getActiveStaff` |
| Packages/Inventory | `items/packages/` | `getpackagedetails` |

---

## Feature 2: Customer Lookup

**Goal:** Search existing customers by phone/name instead of always creating anonymous sales.

### API: `customers_json.cfm?action=getCustomers`
- `matchpartial=1` - enables LIKE search
- `fname` - first name search
- `lname` - last name search
- Returns: customer_id, fname, lname, phone, email, birthdate, license, etc.

### Implementation

1. **Product Cache Service** - add `searchCustomers(query)` method
   ```javascript
   async searchCustomers(query) {
       // POST to customers_json.cfm
       // action: 'getCustomers', matchpartial: 1, fname: query (or lname)
       // Also search by phone with custom query
   }
   ```

2. **Emergency POS UI**
   - Add search input to customer modal
   - Debounced search (300ms delay)
   - Display results as clickable list
   - Selecting customer fills in name/phone/type
   - Store customer_id with transaction

### UI Mockup
```
┌─────────────────────────────────────────┐
│ Customer Info                           │
├─────────────────────────────────────────┤
│ Search: [___________________] [🔍]      │
│                                         │
│ Results:                                │
│ ┌─────────────────────────────────────┐ │
│ │ John Smith - (555) 123-4567         │ │
│ │ john@email.com                      │ │
│ ├─────────────────────────────────────┤ │
│ │ Jane Smith - (555) 987-6543         │ │
│ │ jane@email.com                      │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ Or continue as anonymous:               │
│ Name: [_______________]                 │
│ Phone: [______________]                 │
└─────────────────────────────────────────┘
```

---

## Feature 3: Inventory Display

**Goal:** Show available quantity from packages in cart and package selection modal.

### Current State
- Packages sync with `quantity` field
- Package modal exists but doesn't show inventory

### Implementation

1. **Package Modal Enhancement**
   - Show quantity next to each package
   - Format: `PKG-12345 (Qty: 15)`
   - Red/gray for 0 inventory
   - Sort by quantity or FIFO

2. **Cart Display**
   - Show package quantity in cart item
   - Warning icon if low/zero inventory

### UI Changes
```
Cart item:
  Blue Dream 1g - $20 x 2
  PKG: 1234-5678 (Qty: 5) ⚠️ [Edit]

Package Modal:
  ○ 1234-5678 (Qty: 15)
  ○ 2345-6789 (Qty: 8)
  ○ 3456-7890 (Qty: 0) [Out of Stock]
```

---

## Feature 4: Hold/Recall Transactions

**Goal:** Save current cart to complete later (customer forgot wallet, etc.)

### Implementation

1. **Data Storage** - localStorage `heldTransactions[]`
   - Max 10 held transactions
   - Auto-expire after 24 hours
   - Store: cart, customer, discounts, timestamp, name

2. **UI - Hold Button**
   - Next to Clear button
   - Opens modal to name transaction
   - Saves and clears cart

3. **UI - Recall Button**
   - Shows count badge
   - Lists held transactions
   - Click to recall, option to delete

### UI Mockup
```
Cart Actions:
[Hold 💾] [Clear 🗑️]         [Recall (2)]

Hold Modal:
┌─────────────────────────────────────┐
│ Hold Transaction                    │
│                                     │
│ Name: [John Smith___________]       │
│                                     │
│ [Cancel]  [Hold Transaction]        │
└─────────────────────────────────────┘

Recall Modal:
┌─────────────────────────────────────┐
│ Held Transactions                   │
├─────────────────────────────────────┤
│ John Smith - 3 items - $45.00       │
│ Held 15 min ago            [Delete] │
├─────────────────────────────────────┤
│ Table 5 - 1 item - $20.00           │
│ Held 2 hours ago           [Delete] │
└─────────────────────────────────────┘
```

---

## Feature 6: Employee/Cashier Tracking

**Goal:** Track which employee made each sale.

### API: `staff2_json.cfm?action=getActiveStaff`
- Returns: staff_id, fname, lname, email, status

### Implementation

1. **Product Cache Service** - add `syncEmployees()` method
   - Sync on startup/settings sync
   - Store in categoryDb with `_type: 'employee'`

2. **Emergency POS**
   - On launch: show employee selection modal
   - Store in sessionStorage
   - Display current employee in header
   - Include employee ID in transaction
   - "Switch Employee" option

### UI Mockup
```
Header:
  Emergency POS          Cashier: Jane D. [Switch]

Employee Selection:
┌─────────────────────────────────────┐
│ Select Cashier                      │
├─────────────────────────────────────┤
│ ○ Jane Doe                          │
│ ○ John Smith                        │
│ ○ Bob Wilson                        │
│                                     │
│ [Continue]                          │
└─────────────────────────────────────┘
```

---

## Feature 9: Transaction Notes

**Goal:** Add notes to transactions (discount reasons, special requests, etc.)

### Implementation

1. **UI - Notes Button**
   - Near totals section
   - Opens text modal
   - Max 500 characters

2. **Data Storage**
   - Add `notes` field to transaction
   - Send to API with order

3. **Display**
   - Show note indicator if note exists
   - Include in receipt

### UI Mockup
```
Cart Header:
  Cart (3 items)  [📝 Notes]

Notes Modal:
┌─────────────────────────────────────┐
│ Transaction Notes                   │
├─────────────────────────────────────┤
│ ┌─────────────────────────────────┐ │
│ │ Customer requested extra        │ │
│ │ packaging. Manager approved     │ │
│ │ 10% discount - holiday promo.   │ │
│ └─────────────────────────────────┘ │
│ Characters: 89/500                  │
│                                     │
│ [Cancel]  [Save Note]               │
└─────────────────────────────────────┘
```

---

## Feature 10: Daily Purchase Limits (420)

**Goal:** Track and enforce daily purchase limits for cannabis sales.

### Note: No existing API for daily totals
- Option A: Create new API endpoint
- Option B: Track locally from queued transactions
- Option C: Skip for now, add later

### Recommended: Option A - Add API endpoint

**New action in categories_json.cfm:**
```
action=getCustomerDailyTotal
customerId=123
date=2025-01-13
```
Returns: `{ totalGrams: 15.5, limit: 28, remaining: 12.5 }`

### Implementation

1. **Settings Sync** - add daily limits
   - `dailyLimits.medical` (e.g., 56g)
   - `dailyLimits.recreational` (e.g., 28g)

2. **Product Data** - use `netweight` for gram calculation

3. **Real-time Display**
   - Show in customer panel: "12.5g / 28g used"
   - Warning at 80% of limit
   - Block if would exceed

### UI Mockup
```
Customer Panel:
  John Smith (Recreational)
  Daily Limit: 12.5g / 28g used
  ████████░░░░░░░░ 45%

Warning:
  ⚠️ This sale would exceed daily limit!
  Current: 25g + Adding: 7g = 32g (Limit: 28g)
  [Cancel] [Override with Note]
```

---

## Feature 11: Age Verification Prompt

**Goal:** Ensure cashier verified customer's ID before completing sale.

### API: `customers_json.cfm?action=lookupLicense`
- Can scan driver's license barcode!
- Parses: name, birthdate, license #, expiration
- Already checks if customer exists

### Implementation

1. **Settings** - enable for 420 businesses (auto)

2. **Verification Flow**
   - Before payment, show ID check modal
   - Option to scan license (uses existing API)
   - Or manual checkbox confirm
   - Record verification in transaction

3. **Skip Conditions**
   - Known customer verified recently (configurable)
   - Non-420 business (unless enabled)

### UI Mockup
```
┌─────────────────────────────────────────┐
│ 🪪 Age Verification Required            │
├─────────────────────────────────────────┤
│                                         │
│ Customer must be 21+ for recreational   │
│ cannabis purchases.                     │
│                                         │
│ [Scan License]                          │
│                                         │
│ ─── OR ───                              │
│                                         │
│ ☑ I have verified the customer's        │
│   government-issued photo ID            │
│                                         │
│ [Cancel]  [Proceed to Payment]          │
└─────────────────────────────────────────┘

After Scan:
┌─────────────────────────────────────────┐
│ ✓ ID Verified                           │
├─────────────────────────────────────────┤
│ Name: John Smith                        │
│ DOB: 01/15/1990 (Age: 35)               │
│ License: D1234567                       │
│ Expires: 01/15/2027                     │
│                                         │
│ [Proceed to Payment]                    │
└─────────────────────────────────────────┘
```

---

## Implementation Priority

### Phase 1 - Quick Wins (4-5 hours)
1. **Transaction Notes** (#9) - Simple, standalone
2. **Inventory Display** (#3) - Uses existing data
3. **Age Verification** (#11) - Uses existing lookupLicense API

### Phase 2 - Customer Features (5-6 hours)
4. **Customer Lookup** (#2) - Uses existing getCustomers API
5. **Employee Tracking** (#6) - Uses existing getActiveStaff API

### Phase 3 - Complex Features (6-8 hours)
6. **Hold/Recall** (#4) - Standalone but complex UI
7. **Daily Limits** (#10) - Needs new API endpoint

---

## API Changes Needed

| Feature | API File | Change |
|---------|----------|--------|
| Customer Search | customers_json.cfm | Add phone search |
| Daily Limits | categories_json.cfm | Add getCustomerDailyTotal action |
| Settings | categories_json.cfm | Add dailyLimits to getSettings |

---

## Files to Modify

| File | Changes |
|------|---------|
| emergency-pos.html | All UI changes |
| product-cache-service.js | searchCustomers, syncEmployees |
| main.js | IPC handlers for new features |
| categories_json.cfm | Daily limits API |
| customers_json.cfm | Phone search (optional) |

---

## Ready to Start?

Which feature would you like to implement first?
- **Recommended starting point:** Transaction Notes (#9) - quickest to implement
- **High impact:** Age Verification (#11) - important for compliance
