import type { JSX } from "react";

import type {
  ConfigFieldStatus,
  ConfigFieldView,
  PageConfigView,
} from "../../shared/contracts.js";
import { configValue, fieldLabel } from "../lib/format.js";

const STATUS_COPY: Readonly<
  Record<
    ConfigFieldStatus,
    { readonly label: string; readonly className: string }
  >
> = {
  applied: { label: "已应用", className: "badge--info" },
  verified: { label: "已验证", className: "badge--success" },
  unsupported: { label: "不支持", className: "badge--warning" },
  failed: { label: "失败", className: "badge--danger" },
  not_verified: { label: "未验证", className: "" },
};

export interface VerificationTableProps {
  readonly fields: readonly ConfigFieldView[];
}

export function VerificationTable({
  fields,
}: VerificationTableProps): JSX.Element {
  return (
    <table className="verify-table">
      <thead>
        <tr>
          <th scope="col">配置</th>
          <th scope="col">状态</th>
          <th scope="col">期望值</th>
          <th scope="col">实际观测</th>
        </tr>
      </thead>
      <tbody>
        {fields.map((field) => {
          const status = STATUS_COPY[field.status];
          return (
            <tr key={field.field}>
              <td className="verify-table__field">
                {fieldLabel(field.field)}
                {field.reason === undefined ? null : (
                  <span className="verify-table__reason">{field.reason}</span>
                )}
              </td>
              <td>
                <span
                  className={["badge", status.className]
                    .filter(Boolean)
                    .join(" ")}
                >
                  {status.label}
                </span>
              </td>
              <td className="verify-table__value">
                {configValue(field.requested)}
              </td>
              <td className="verify-table__value">
                {configValue(field.observed)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export interface PageVerificationProps {
  readonly page: PageConfigView;
}

export function PageVerification({ page }: PageVerificationProps): JSX.Element {
  return (
    <div className="section">
      <div className="section__header">
        <span className="section__title">
          {page.pageId === "initial"
            ? "起始页面"
            : /^page-\d+$/.test(page.pageId)
              ? `页面 ${page.pageId.slice("page-".length)}`
              : page.pageId}
        </span>
        <span
          className="mono"
          style={{ fontSize: 10.5, color: "var(--text-tertiary)" }}
        >
          {page.url}
        </span>
      </div>
      <VerificationTable fields={page.fields} />
    </div>
  );
}
