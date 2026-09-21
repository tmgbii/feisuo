export interface OsBrand {
  label: string;
  color: string;
  pretty: string;
}

const TABLE: Record<string, { label: string; color: string }> = {
  macos: { label: "macOS", color: "#A2AAAD" },
  darwin: { label: "macOS", color: "#A2AAAD" },
  ubuntu: { label: "Ubuntu", color: "#E95420" },
  debian: { label: "Debian", color: "#A80030" },
  linuxmint: { label: "Mint", color: "#87CF3E" },
  fedora: { label: "Fedora", color: "#51A2DA" },
  centos: { label: "CentOS", color: "#262577" },
  rhel: { label: "RHEL", color: "#EE0000" },
  rocky: { label: "Rocky", color: "#10B981" },
  almalinux: { label: "Alma", color: "#0F7A3A" },
  alpine: { label: "Alpine", color: "#0D597F" },
  arch: { label: "Arch", color: "#1793D1" },
  manjaro: { label: "Manjaro", color: "#35BF5C" },
  opensuse: { label: "openSUSE", color: "#73BA25" },
  sles: { label: "SLES", color: "#0C322C" },
  kali: { label: "Kali", color: "#268BD2" },
  raspbian: { label: "Raspberry Pi OS", color: "#C51A4A" },
  freebsd: { label: "FreeBSD", color: "#AB2B28" },
  openwrt: { label: "OpenWrt", color: "#00B5E2" },
};

export function osBrand(id?: string, distro?: string, uname?: string): OsBrand | null {
  const pretty = (distro ?? "").trim();
  const key = (id ?? "").trim().toLowerCase();
  if (TABLE[key]) return { ...TABLE[key], pretty: pretty || TABLE[key].label };
  if (/darwin/i.test(uname ?? "") || /macos/i.test(pretty)) {
    return { ...TABLE.macos, pretty: pretty || TABLE.macos.label };
  }
  const token = pretty.split(/[\s/_-]/)[0]?.toLowerCase() ?? "";
  if (TABLE[token]) return { ...TABLE[token], pretty: pretty || TABLE[token].label };
  if (pretty) return { label: pretty, color: "#64748b", pretty };
  if (/linux/i.test(uname ?? "")) return { label: "Linux", color: "#64748b", pretty: uname ?? "Linux" };
  return null;
}
