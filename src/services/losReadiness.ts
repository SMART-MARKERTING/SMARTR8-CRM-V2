import { Lead, Todo, addTodo, logActivityOnce } from "./leads";

export interface LosDocumentRequirement {
  key: string;
  label: string;
  category: "borrower" | "property" | "income" | "entity" | "closing";
  required: boolean;
  expires: string;
  complete: boolean;
  detail: string;
  todoText: string;
}

export interface LosReadiness {
  ok: boolean;
  score: number;
  requiredCount: number;
  completedRequiredCount: number;
  missingRequiredCount: number;
  missingRequired: string[];
  nextActions: string[];
  applicationStarted: boolean;
  authorizationOnFile: boolean;
  requirements: LosDocumentRequirement[];
  checklistSource: string;
}

function norm(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truthy(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) && value !== 0;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    return Boolean(v) && v !== "false" && v !== "no" && v !== "0";
  }
  return Boolean(value);
}

function customHas(lead: Lead, keys: string[]): boolean {
  const custom = lead.custom || {};
  return keys.some((key) => truthy(custom[key]));
}

function activeTodos(lead: Lead): Todo[] {
  return (lead.todos || []).filter((todo) => !todo.deleted_at);
}

function completedTodoIncludes(lead: Lead, needles: string[]): boolean {
  const normalizedNeedles = needles.map(norm).filter(Boolean);
  if (!normalizedNeedles.length) return false;
  return activeTodos(lead).some((todo) => {
    if (!todo.done) return false;
    const text = norm(todo.text);
    return normalizedNeedles.some((needle) => text.includes(needle));
  });
}

function hasLoanPurpose(lead: Lead, values: string[]): boolean {
  const custom = lead.custom || {};
  const raw = [
    custom.loan_purpose,
    custom.loan_goal,
    custom.purpose,
    custom.loanType,
    custom.loan_type,
    custom.program,
    custom.loan_program,
    lead.campaign,
    lead.pipeline_stage,
  ]
    .map(norm)
    .join(" ");
  return values.some((value) => raw.includes(norm(value)));
}

function hasEntityVesting(lead: Lead): boolean {
  const custom = lead.custom || {};
  return [
    custom.entity_name,
    custom.entityName,
    custom.vesting,
    custom.borrowing_entity,
    custom.borrowingEntity,
    custom.business_name,
    custom.businessName,
  ].some((value) => {
    const v = norm(value);
    return Boolean(v) && (v.includes("llc") || v.includes("corp") || v.includes("trust") || v.includes("inc"));
  });
}

function requirement(
  lead: Lead,
  opts: {
    key: string;
    label: string;
    category: LosDocumentRequirement["category"];
    required?: boolean;
    expires?: string;
    customKeys: string[];
    todoNeedles?: string[];
    detailWhenMissing: string;
    detailWhenComplete?: string;
    todoText: string;
  },
): LosDocumentRequirement {
  const complete =
    customHas(lead, opts.customKeys) ||
    completedTodoIncludes(lead, [opts.label, opts.key, ...(opts.todoNeedles || [])]);
  return {
    key: opts.key,
    label: opts.label,
    category: opts.category,
    required: opts.required ?? true,
    expires: opts.expires || "Never",
    complete,
    detail: complete ? opts.detailWhenComplete || "Complete on the borrower file." : opts.detailWhenMissing,
    todoText: opts.todoText,
  };
}

export function getLosReadiness(lead: Lead): LosReadiness {
  const isPurchase = hasLoanPurpose(lead, ["purchase"]);
  const isRefi = hasLoanPurpose(lead, ["refinance", "refi", "cash out", "cash-out"]);
  const isDscr = hasLoanPurpose(lead, ["dscr", "investment", "rental"]);
  const requirements: LosDocumentRequirement[] = [
    requirement(lead, {
      key: "photo_id",
      label: "Photo ID",
      category: "borrower",
      customKeys: ["doc_photo_id", "photo_id", "photo_id_uploaded_at", "photo_id_received_at"],
      detailWhenMissing: "Required borrower identity document.",
      todoText: "Collect Photo ID",
    }),
    requirement(lead, {
      key: "borrower_authorization",
      label: "Borrower Authorization",
      category: "borrower",
      customKeys: [
        "borrower_authorization",
        "borrower_authorization_on_file",
        "borrower_authorization_at",
        "credit_authorization",
        "credit_authorization_at",
      ],
      todoNeedles: ["credit authorization"],
      detailWhenMissing: "Required before credit, title, flood, or loan-file exposure.",
      todoText: "Collect Borrower Authorization / credit authorization",
    }),
    requirement(lead, {
      key: "loan_application",
      label: "Loan application / URLA summary",
      category: "borrower",
      customKeys: ["application_completed_at", "application_submitted_at", "urla_completed_at", "loan_application_at"],
      detailWhenMissing: "Complete borrower, property, purpose, and loan request fields.",
      todoText: "Complete loan application / URLA summary",
    }),
    requirement(lead, {
      key: "credit_report",
      label: "Credit report",
      category: "borrower",
      expires: "30 days",
      customKeys: ["credit_report_at", "credit_report", "tri_merge_at", "credit_requested_at"],
      detailWhenMissing: "Tri-merge or vendor credit request is not on the file.",
      detailWhenComplete: "Credit request/report is recorded on the file.",
      todoText: "Queue credit report after borrower authorization",
    }),
    requirement(lead, {
      key: "income_assets",
      label: "Income / assets documentation",
      category: "income",
      customKeys: ["income_docs_at", "asset_docs_at", "bank_statements_at", "income_assets_complete"],
      detailWhenMissing: "Collect income, assets, or business-purpose support before underwriting.",
      todoText: "Collect income / assets documentation",
    }),
    requirement(lead, {
      key: "property_insurance",
      label: "Property insurance",
      category: "property",
      customKeys: ["property_insurance_at", "insurance_at", "hazard_insurance_at", "insurance_received_at"],
      detailWhenMissing: "Insurance evidence is missing from the property file.",
      todoText: "Collect property insurance evidence",
    }),
  ];

  if (isPurchase) {
    requirements.push(
      requirement(lead, {
        key: "purchase_contract",
        label: "Purchase contract",
        category: "closing",
        customKeys: ["purchase_contract_at", "purchase_contract", "sales_contract_at"],
        detailWhenMissing: "Purchase file needs the signed purchase contract.",
        todoText: "Collect signed purchase contract",
      }),
    );
  }

  if (isRefi) {
    requirements.push(
      requirement(lead, {
        key: "payoff_statement",
        label: "Payoff statement",
        category: "closing",
        customKeys: ["payoff_statement_at", "payoff_at", "mortgage_statement_at"],
        detailWhenMissing: "Refinance/cash-out file needs the payoff or mortgage statement.",
        todoText: "Collect payoff / mortgage statement",
      }),
    );
  }

  if (isDscr) {
    requirements.push(
      requirement(lead, {
        key: "rent_roll_or_lease",
        label: "Rent roll / lease",
        category: "property",
        customKeys: ["rent_roll_at", "lease_at", "lease_agreement_at", "rental_income_docs_at"],
        detailWhenMissing: "DSCR/investment file needs lease, rent roll, or rental income support.",
        todoText: "Collect rent roll / lease agreement",
      }),
    );
  }

  if (hasEntityVesting(lead)) {
    requirements.push(
      requirement(lead, {
        key: "entity_documents",
        label: "Entity documents",
        category: "entity",
        customKeys: ["entity_docs_at", "operating_agreement_at", "articles_at", "entity_documents_at"],
        detailWhenMissing: "Entity vesting needs articles, operating agreement, and signing authority.",
        todoText: "Collect entity documents and signing authority",
      }),
    );
  }

  const required = requirements.filter((item) => item.required);
  const completedRequired = required.filter((item) => item.complete);
  const missingRequired = required.filter((item) => !item.complete);
  return {
    ok: missingRequired.length === 0,
    score: required.length ? Math.round((completedRequired.length / required.length) * 100) : 100,
    requiredCount: required.length,
    completedRequiredCount: completedRequired.length,
    missingRequiredCount: missingRequired.length,
    missingRequired: missingRequired.map((item) => item.label),
    nextActions: missingRequired.slice(0, 5).map((item) => item.todoText),
    applicationStarted: customHas(lead, ["application_started_at"]),
    authorizationOnFile: requirements.some((item) => item.key === "borrower_authorization" && item.complete),
    requirements,
    checklistSource: "LoanGenius document, portal, MISMO, and security specs",
  };
}

export function hasBorrowerAuthorization(lead: Lead): boolean {
  return getLosReadiness(lead).authorizationOnFile;
}

export function seedLosDocumentTodos(lead: Lead, author?: string): { added: number; requiredCount: number } {
  const readiness = getLosReadiness(lead);
  const existing = new Set(activeTodos(lead).map((todo) => norm(todo.text)));
  let added = 0;

  for (const item of readiness.requirements) {
    if (!item.required || item.complete) continue;
    const text = `LOS: ${item.todoText}`;
    const normalized = norm(text);
    if (existing.has(normalized)) continue;
    addTodo(lead.id, text);
    existing.add(normalized);
    added += 1;
  }

  if (added) {
    logActivityOnce(
      lead.id,
      {
        type: "document_requirements",
        direction: "system",
        channel: "system",
        body: `Seeded ${added} LOS document checklist item${added === 1 ? "" : "s"}.`,
        status: "seeded",
        meta: { author: author ?? null, source: "loangenius_specs" },
      },
      60_000,
    );
  }

  return { added, requiredCount: readiness.requiredCount };
}
