import { Lead } from "./leads";

// MISMO v3.4 (Residential) export for a lead — shaped to feed a pricing engine / LOS import.
// It carries the fields we collect: borrower (name, contact, DOB), subject property
// (address, estimated + appraised value, occupancy, type, units), and loan terms (purpose,
// type, amount, note rate, credit score, program, purchase price). Fields with no data are
// omitted. It's a valid MISMO-3.4-namespaced subset, not a complete underwritable 1003.
//
// Address mapping: the CRM stores ONE address per lead. On export we echo that single
// address into all three sections the LOS imports from — the SUBJECT_PROPERTY, the REO
// (ASSETS → ASSET RealEstateOwned / OWNED_PROPERTY, flagged subject), and the borrower's
// current RESIDENCE (+ party ADDRESSES) — so one CRM address populates each on import.

const NS = "http://www.mismo.org/residential/2009/schemas";

function xml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** First non-empty custom value across several key spellings. */
function cf(lead: Lead, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = lead.custom?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && !Number.isNaN(v)) return String(v);
  }
  return undefined;
}

/** Strip a currency-ish string to a plain number string (or undefined if not positive). */
function amount(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const n = parseFloat(String(raw).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? String(n) : undefined;
}

/** Strip to a plain percent number (e.g. "6.875%" → "6.875"). */
function percent(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const n = parseFloat(String(raw).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? String(n) : undefined;
}

/** First integer found (units, FICO). */
function intVal(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const m = String(raw).match(/\d{2,}/) || String(raw).match(/\d+/);
  return m ? String(parseInt(m[0], 10)) : undefined;
}

function dob(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return undefined;
}

function ssn(raw: string | undefined): string | undefined {
  const digits = raw?.replace(/\D/g, "").slice(0, 9);
  return digits && digits.length === 9 ? digits : undefined;
}

function exportCreatedDatetime(lead: Lead): string {
  const source = lead.created_at || 0;
  const date = new Date(source);
  return Number.isNaN(date.getTime()) ? "1970-01-01T00:00:00.000Z" : date.toISOString();
}

/** Map free-text loan goal → MISMO LoanPurposeType. */
function loanPurpose(lead: Lead): string {
  const g = (cf(lead, ["loan_purpose", "loan_goal", "loanGoal", "purpose", "loanType", "loan_type"]) || "").toLowerCase();
  if (/purchase|buy|buying/.test(g)) return "Purchase";
  if (/construction/.test(g)) return "Construction";
  return "Refinance";
}

/** Map free-text loan type → MISMO MortgageType (Conventional/FHA/VA/USDA…). */
function mortgageType(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const t = raw.toLowerCase();
  if (/\bva\b|veteran/.test(t)) return "VA";
  if (/\bfha\b/.test(t)) return "FHA";
  if (/usda|rural/.test(t)) return "USDARuralDevelopment";
  if (/conv|conforming|jumbo|non.?qm|agency/.test(t)) return "Conventional";
  return "Conventional";
}

/** Map free-text occupancy → MISMO PropertyUsageType. */
function occupancy(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const o = raw.toLowerCase();
  if (/primary|owner|principal/.test(o)) return "PrimaryResidence";
  if (/second|vacation/.test(o)) return "SecondHome";
  if (/invest|rental/.test(o)) return "Investment";
  return undefined;
}

/** Map free-text property type → MISMO attachment-ish descriptor. */
function propertyType(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const p = raw.toLowerCase();
  if (/detach|single/.test(p)) return "Detached";
  if (/attach|townhouse|town home/.test(p)) return "Attached";
  if (/condo/.test(p)) return "Condominium";
  return raw.trim();
}

export function buildMismo34(lead: Lead): string {
  const first = lead.first_name || "";
  const last = lead.last_name || "";
  const middle = cf(lead, ["middle_name", "middleName"]);
  const phone = lead.phone || "";
  const email = lead.email || "";

  const street = cf(lead, ["address", "street", "street_address", "streetAddress", "address1"]);
  const city = cf(lead, ["city", "City"]);
  const state = cf(lead, ["state", "property_state", "State", "region", "Region"]);
  const zip = cf(lead, ["zip", "zip_code", "zipCode", "postal_code", "postalCode"]);
  const county = cf(lead, ["county", "County"]);

  const estValue = amount(cf(lead, ["home_value", "homeValue", "Home Value", "estimated_value", "property_value", "propertyValue"]));
  const appraised = amount(cf(lead, ["appraised_value", "appraisal_value", "appraisedValue"]));
  const purchasePrice = amount(cf(lead, ["purchase_price", "purchasePrice", "sales_price", "salesPrice"]));
  const units = intVal(cf(lead, ["units", "unit_count", "financed_units"]));
  const occ = occupancy(cf(lead, ["occupancy", "occupancy_type", "occupancyType"]));
  const propType = propertyType(cf(lead, ["property_type", "propertyType"]));

  const mortgageBalance = amount(cf(lead, ["mortgage_balance", "mortgageBalance", "Mortgage Balance"]));
  const baseLoan =
    amount(cf(lead, ["loan_amount", "loanAmount", "Loan Amount"])) ||
    amount(cf(lead, ["heloc_line", "helocLine", "heloc_line_available", "HELOC Line Available"]));
  const cashOut = amount(cf(lead, ["cash_out", "cashOut", "Cash Out", "cash_out_amount"]));
  const monthlyPayment = amount(cf(lead, ["monthly_payment", "monthlyPayment", "Monthly Payment"]));
  const noteRate = percent(cf(lead, ["note_rate", "noteRate", "interest_rate", "interestRate", "rate"]));
  const mType = mortgageType(cf(lead, ["loan_type", "loanType"]));
  const program = cf(lead, ["program", "loan_program", "loanProgram"]);
  const fico = intVal(cf(lead, ["credit_score", "creditScore", "fico", "FICO", "credit"]));
  const ssnValue = ssn(cf(lead, ["ssn", "ssn_full", "borrower_ssn", "social_security_number", "taxpayer_identifier"]));
  const monthlyIncome = amount(cf(lead, ["monthly_income", "monthlyIncome", "gross_monthly_income", "income"]));
  const employer = cf(lead, ["employer", "employer_name", "employment_employer", "current_employer", "income_source"]);
  const coFirst = cf(lead, ["co_borrower_first_name", "coborrower_first_name", "coBorrowerFirstName"]);
  const coLast = cf(lead, ["co_borrower_last_name", "coborrower_last_name", "coBorrowerLastName"]);
  const coPhone = cf(lead, ["co_borrower_phone", "coborrower_phone", "coBorrowerPhone"]);
  const coEmail = cf(lead, ["co_borrower_email", "coborrower_email", "coBorrowerEmail"]);
  const coDob = dob(cf(lead, ["co_borrower_dob", "coborrower_dob", "coBorrowerDob"]));
  const coSsn = ssn(cf(lead, ["co_borrower_ssn", "coborrower_ssn", "coBorrowerSsn"]));
  const coFico = intVal(cf(lead, ["co_borrower_credit_score", "coborrower_credit_score", "coBorrowerCreditScore"]));
  const coIncome = amount(cf(lead, ["co_borrower_monthly_income", "coborrower_monthly_income", "coBorrowerMonthlyIncome"]));
  const coEmployer = cf(lead, ["co_borrower_employer", "coborrower_employer", "coBorrowerEmployer"]);
  const purpose = loanPurpose(lead);

  const line = (tag: string, val: string | undefined, indent: string): string =>
    val ? `${indent}<${tag}>${xml(val)}</${tag}>\n` : "";

  // The CRM holds a single address. We emit it (in correct MISMO element order, with an
  // AddressType) into every place the LOS reads a property/residence address, so one CRM
  // address populates the subject property, the REO, and the borrower's residence on import.
  const hasAddr = !!(street || city || state || zip);
  const addressBlock = (type: string, indent: string): string =>
    line("AddressLineText", street, indent) +
    `${indent}<AddressType>${xml(type)}</AddressType>\n` +
    line("CityName", city, indent) +
    line("CountyName", county, indent) +
    line("PostalCode", zip, indent) +
    line("StateCode", state, indent) +
    line("StateName", state, indent);

  // ── ASSETS: REO (the subject property as the borrower's owned real estate) ──
  // Same CRM address + value, flagged as the subject property so the LOS imports it as REO.
  const reoAssets = hasAddr
    ? `      <ASSETS>
        <ASSET xlink:label="ASSET_0">
          <ASSET_DETAIL>
${estValue ? `            <AssetCashOrMarketValueAmount>${xml(estValue)}</AssetCashOrMarketValueAmount>
            <AssetNetValueAmount>${xml(estValue)}</AssetNetValueAmount>\n` : ""}            <AssetType>RealEstateOwned</AssetType>
          </ASSET_DETAIL>
          <ASSET_HOLDER>
            <ADDRESS>
${addressBlock("Primary", "              ")}            </ADDRESS>
            <NAME>
              <FirstName>${xml(first)}</FirstName>
              <LastName>${xml(last)}</LastName>
            </NAME>
          </ASSET_HOLDER>
          <OWNED_PROPERTY>
            <OWNED_PROPERTY_DETAIL>
              <OwnedPropertySubjectIndicator>true</OwnedPropertySubjectIndicator>
            </OWNED_PROPERTY_DETAIL>
          </OWNED_PROPERTY>
        </ASSET>
      </ASSETS>\n`
    : "";

  // ── SUBJECT_PROPERTY ──
  const addr = hasAddr ? addressBlock("Primary", "              ") : "";
  const propDetail =
    line("PropertyEstimatedValueAmount", estValue, "              ") +
    line("PropertyUsageType", occ, "              ") +
    line("PropertyStructureBuiltYear", undefined, "              ") +
    line("FinancedUnitCount", units, "              ") +
    line("AttachmentType", propType, "              ");
  const valuation = appraised
    ? `            <PROPERTY_VALUATIONS>
              <PROPERTY_VALUATION>
                <PROPERTY_VALUATION_DETAIL>
                  <PropertyValuationAmount>${xml(appraised)}</PropertyValuationAmount>
                  <PropertyValuationMethodType>PriorAppraisalUsed</PropertyValuationMethodType>
                </PROPERTY_VALUATION_DETAIL>
              </PROPERTY_VALUATION>
            </PROPERTY_VALUATIONS>\n`
    : "";
  const subjectProperty =
    addr || propDetail || valuation
      ? `      <COLLATERALS>
        <COLLATERAL>
          <SUBJECT_PROPERTY>
${addr ? `            <ADDRESS>\n${addr}            </ADDRESS>\n` : ""}${propDetail ? `            <PROPERTY_DETAIL>\n${propDetail}            </PROPERTY_DETAIL>\n` : ""}${valuation}          </SUBJECT_PROPERTY>
        </COLLATERAL>
      </COLLATERALS>\n`
      : "";

  // ── SALES_CONTRACT (purchase price) ──
  const salesContract = purchasePrice
    ? `      <SALES_CONTRACTS>
        <SALES_CONTRACT>
          <SALES_CONTRACT_DETAIL>
            <SalesContractAmount>${xml(purchasePrice)}</SalesContractAmount>
          </SALES_CONTRACT_DETAIL>
        </SALES_CONTRACT>
      </SALES_CONTRACTS>\n`
    : "";

  // Current mortgage balance belongs to the borrower's liabilities. It should not be
  // treated as the new loan amount unless the CRM explicitly has no separate loan amount.
  const liabilities = mortgageBalance
    ? `      <LIABILITIES>
        <LIABILITY>
          <LIABILITY_DETAIL>
            <LiabilityType>MortgageLoan</LiabilityType>
            <LiabilityUnpaidBalanceAmount>${xml(mortgageBalance)}</LiabilityUnpaidBalanceAmount>
${monthlyPayment ? `            <LiabilityMonthlyPaymentAmount>${xml(monthlyPayment)}</LiabilityMonthlyPaymentAmount>\n` : ""}          </LIABILITY_DETAIL>
        </LIABILITY>
      </LIABILITIES>\n`
    : "";

  // ── LOAN ──
  const terms =
    `            <LoanPurposeType>${xml(purpose)}</LoanPurposeType>\n` +
    line("MortgageType", mType, "            ") +
    line("BaseLoanAmount", baseLoan, "            ") +
    line("NoteRatePercent", noteRate, "            ") +
    `            <LienPriorityType>FirstLien</LienPriorityType>\n`;
  const refinance =
    purpose === "Refinance" && cashOut
      ? `          <REFINANCE>
            <RefinanceCashOutDeterminationType>CashOut</RefinanceCashOutDeterminationType>
            <RefinanceCashOutAmount>${xml(cashOut)}</RefinanceCashOutAmount>
          </REFINANCE>\n`
      : "";
  const loanProduct = program
    ? `          <LOAN_PRODUCT>
            <LOAN_PRODUCT_DETAIL>
              <LoanProductDescription>${xml(program)}</LoanProductDescription>
            </LOAN_PRODUCT_DETAIL>
          </LOAN_PRODUCT>\n`
    : "";
  const loan = `      <LOANS>
        <LOAN>
          <TERMS_OF_LOAN>
${terms}          </TERMS_OF_LOAN>
${refinance}${loanProduct}        </LOAN>
      </LOANS>\n`;

  // ── BORROWER party ──
  const nameInner =
    `              <FirstName>${xml(first)}</FirstName>\n` +
    line("MiddleName", middle, "              ") +
    `              <LastName>${xml(last)}</LastName>\n`;
  const contactPoints =
    phone || email
      ? `            <CONTACT_POINTS>
${phone ? `              <CONTACT_POINT>
                <CONTACT_POINT_TELEPHONE>
                  <ContactPointTelephoneValue>${xml(phone)}</ContactPointTelephoneValue>
                </CONTACT_POINT_TELEPHONE>
              </CONTACT_POINT>\n` : ""}${email ? `              <CONTACT_POINT>
                <CONTACT_POINT_EMAIL>
                  <ContactPointEmailValue>${xml(email)}</ContactPointEmailValue>
                </CONTACT_POINT_EMAIL>
              </CONTACT_POINT>\n` : ""}            </CONTACT_POINTS>\n`
      : "";
  const birth = dob(cf(lead, ["dob", "borrower_dob", "date_of_birth", "dateOfBirth", "DOB"]));
  const creditScores = fico
    ? `                <CREDIT_SCORES>
                  <CREDIT_SCORE>
                    <CREDIT_SCORE_DETAIL>
                      <CreditScoreValue>${xml(fico)}</CreditScoreValue>
                    </CREDIT_SCORE_DETAIL>
                  </CREDIT_SCORE>
                </CREDIT_SCORES>\n`
    : "";
  const taxpayerIdentifiers = ssnValue
    ? `                <TAXPAYER_IDENTIFIERS>
                  <TAXPAYER_IDENTIFIER>
                    <TaxpayerIdentifierType>SocialSecurityNumber</TaxpayerIdentifierType>
                    <TaxpayerIdentifierValue>${xml(ssnValue)}</TaxpayerIdentifierValue>
                  </TAXPAYER_IDENTIFIER>
                </TAXPAYER_IDENTIFIERS>\n`
    : "";
  const currentIncome = monthlyIncome
    ? `                <CURRENT_INCOME>
                  <CURRENT_INCOME_ITEMS>
                    <CURRENT_INCOME_ITEM>
                      <CURRENT_INCOME_ITEM_DETAIL>
                        <IncomeMonthlyTotalAmount>${xml(monthlyIncome)}</IncomeMonthlyTotalAmount>
                        <IncomeType>Base</IncomeType>
                      </CURRENT_INCOME_ITEM_DETAIL>
                    </CURRENT_INCOME_ITEM>
                  </CURRENT_INCOME_ITEMS>
                </CURRENT_INCOME>\n`
    : "";
  const employment = employer || monthlyIncome
    ? `                <EMPLOYERS>
                  <EMPLOYER>
                    <EMPLOYMENT>
                      <EmploymentCurrentIndicator>true</EmploymentCurrentIndicator>
${monthlyIncome ? `                      <EmploymentMonthlyIncomeAmount>${xml(monthlyIncome)}</EmploymentMonthlyIncomeAmount>\n` : ""}                    </EMPLOYMENT>
${employer ? `                    <LEGAL_ENTITY>
                      <LEGAL_ENTITY_DETAIL>
                        <FullName>${xml(employer)}</FullName>
                      </LEGAL_ENTITY_DETAIL>
                    </LEGAL_ENTITY>\n` : ""}                  </EMPLOYER>
                </EMPLOYERS>\n`
    : "";
  const legacyEmployer = employer
    ? `                <EMPLOYERS>
                  <EMPLOYER>
                    <LEGAL_ENTITY>
                      <LEGAL_ENTITY_DETAIL>
                        <FullName>${xml(employer)}</FullName>
                      </LEGAL_ENTITY_DETAIL>
                    </LEGAL_ENTITY>
                  </EMPLOYER>
                </EMPLOYERS>\n`
    : "";
  // Borrower's current residence — the same CRM address, so it lands in the residence section.
  const residences = hasAddr
    ? `                <RESIDENCES>
                  <RESIDENCE>
                    <ADDRESS>
${addressBlock("Current", "                      ")}                    </ADDRESS>
                    <RESIDENCE_DETAIL>
                      <BorrowerResidencyType>Current</BorrowerResidencyType>
                    </RESIDENCE_DETAIL>
                  </RESIDENCE>
                </RESIDENCES>\n`
    : "";
  const borrowerInner =
    `${birth ? `                <BORROWER_DETAIL>
                  <BorrowerBirthDate>${xml(birth)}</BorrowerBirthDate>
                </BORROWER_DETAIL>\n` : ""}${taxpayerIdentifiers}${creditScores}${currentIncome}${employment || legacyEmployer}${residences}`;
  // Party-level current address (mirrors the residence) — same single CRM address.
  const partyAddresses = hasAddr
    ? `          <ADDRESSES>
            <ADDRESS>
${addressBlock("Current", "              ")}            </ADDRESS>
          </ADDRESSES>\n`
    : "";
  const coBorrowerNameInner =
    coFirst || coLast
      ? `              <FirstName>${xml(coFirst || "")}</FirstName>\n` +
        `              <LastName>${xml(coLast || "")}</LastName>\n`
      : "";
  const coBorrowerContactPoints =
    coPhone || coEmail
      ? `            <CONTACT_POINTS>
${coPhone ? `              <CONTACT_POINT>
                <CONTACT_POINT_TELEPHONE>
                  <ContactPointTelephoneValue>${xml(coPhone)}</ContactPointTelephoneValue>
                </CONTACT_POINT_TELEPHONE>
              </CONTACT_POINT>\n` : ""}${coEmail ? `              <CONTACT_POINT>
                <CONTACT_POINT_EMAIL>
                  <ContactPointEmailValue>${xml(coEmail)}</ContactPointEmailValue>
                </CONTACT_POINT_EMAIL>
              </CONTACT_POINT>\n` : ""}            </CONTACT_POINTS>\n`
      : "";
  const coBorrowerIdentifiers = coSsn
    ? `                <TAXPAYER_IDENTIFIERS>
                  <TAXPAYER_IDENTIFIER>
                    <TaxpayerIdentifierType>SocialSecurityNumber</TaxpayerIdentifierType>
                    <TaxpayerIdentifierValue>${xml(coSsn)}</TaxpayerIdentifierValue>
                  </TAXPAYER_IDENTIFIER>
                </TAXPAYER_IDENTIFIERS>\n`
    : "";
  const coBorrowerCreditScores = coFico
    ? `                <CREDIT_SCORES>
                  <CREDIT_SCORE>
                    <CREDIT_SCORE_DETAIL>
                      <CreditScoreValue>${xml(coFico)}</CreditScoreValue>
                    </CREDIT_SCORE_DETAIL>
                  </CREDIT_SCORE>
                </CREDIT_SCORES>\n`
    : "";
  const coBorrowerIncome = coIncome
    ? `                <CURRENT_INCOME>
                  <CURRENT_INCOME_ITEMS>
                    <CURRENT_INCOME_ITEM>
                      <CURRENT_INCOME_ITEM_DETAIL>
                        <IncomeMonthlyTotalAmount>${xml(coIncome)}</IncomeMonthlyTotalAmount>
                        <IncomeType>Base</IncomeType>
                      </CURRENT_INCOME_ITEM_DETAIL>
                    </CURRENT_INCOME_ITEM>
                  </CURRENT_INCOME_ITEMS>
                </CURRENT_INCOME>\n`
    : "";
  const coBorrowerEmployment = coEmployer || coIncome
    ? `                <EMPLOYERS>
                  <EMPLOYER>
                    <EMPLOYMENT>
                      <EmploymentCurrentIndicator>true</EmploymentCurrentIndicator>
${coIncome ? `                      <EmploymentMonthlyIncomeAmount>${xml(coIncome)}</EmploymentMonthlyIncomeAmount>\n` : ""}                    </EMPLOYMENT>
${coEmployer ? `                    <LEGAL_ENTITY>
                      <LEGAL_ENTITY_DETAIL>
                        <FullName>${xml(coEmployer)}</FullName>
                      </LEGAL_ENTITY_DETAIL>
                    </LEGAL_ENTITY>\n` : ""}                  </EMPLOYER>
                </EMPLOYERS>\n`
    : "";
  const legacyCoBorrowerEmployment = coEmployer
    ? `                <EMPLOYERS>
                  <EMPLOYER>
                    <LEGAL_ENTITY>
                      <LEGAL_ENTITY_DETAIL>
                        <FullName>${xml(coEmployer)}</FullName>
                      </LEGAL_ENTITY_DETAIL>
                    </LEGAL_ENTITY>
                  </EMPLOYER>
                </EMPLOYERS>\n`
    : "";
  const coBorrowerInner =
    `${coDob ? `                <BORROWER_DETAIL>
                  <BorrowerBirthDate>${xml(coDob)}</BorrowerBirthDate>
                </BORROWER_DETAIL>\n` : ""}${coBorrowerIdentifiers}${coBorrowerCreditScores}${coBorrowerIncome}${coBorrowerEmployment || legacyCoBorrowerEmployment}`;
  const coBorrowerParty = coBorrowerNameInner
    ? `        <PARTY>
          <INDIVIDUAL>
            <NAME>
${coBorrowerNameInner}            </NAME>
${coBorrowerContactPoints}          </INDIVIDUAL>
          <ROLES>
            <ROLE>
              <BORROWER>
${coBorrowerInner}              </BORROWER>
              <ROLE_DETAIL>
                <PartyRoleType>CoBorrower</PartyRoleType>
              </ROLE_DETAIL>
            </ROLE>
          </ROLES>
        </PARTY>\n`
    : "";
  const party = `      <PARTIES>
        <PARTY>
          <INDIVIDUAL>
            <NAME>
${nameInner}            </NAME>
${contactPoints}          </INDIVIDUAL>
${partyAddresses}          <ROLES>
            <ROLE>
              <BORROWER>
${borrowerInner}              </BORROWER>
              <ROLE_DETAIL>
                <PartyRoleType>Borrower</PartyRoleType>
              </ROLE_DETAIL>
            </ROLE>
          </ROLES>
        </PARTY>
${coBorrowerParty}
      </PARTIES>\n`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<MESSAGE xmlns="${NS}" xmlns:xlink="http://www.w3.org/1999/xlink" MISMOReferenceModelIdentifier="3.4.0">
  <ABOUT_VERSIONS>
    <ABOUT_VERSION>
      <CreatedDatetime>${exportCreatedDatetime(lead)}</CreatedDatetime>
      <DataVersionName>MISMO 3.4.0</DataVersionName>
    </ABOUT_VERSION>
  </ABOUT_VERSIONS>
  <DEAL_SETS>
    <DEAL_SET>
      <DEALS>
        <DEAL>
${reoAssets}${subjectProperty}${liabilities}${loan}${party}${salesContract}        </DEAL>
      </DEALS>
    </DEAL_SET>
  </DEAL_SETS>
</MESSAGE>
`;
}

/** Safe download filename for a lead's MISMO file. */
export function mismoFilename(lead: Lead): string {
  const base = [lead.first_name, lead.last_name].filter(Boolean).join("_") || lead.phone || lead.id;
  return `${String(base).replace(/[^A-Za-z0-9._-]/g, "_")}_MISMO_3.4.xml`;
}
