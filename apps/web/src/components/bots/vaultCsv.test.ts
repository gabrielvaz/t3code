import { describe, expect, it } from "vite-plus/test";

import { parseCsv, parseVaultCsv } from "./vaultCsv";

describe("parseCsv", () => {
  it("reads quoted fields, doubled quotes, CRLF and a BOM", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\n\n"multi\nline",z')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["multi\nline", "z"],
    ]);
  });
});

describe("parseVaultCsv", () => {
  it("reads a Chrome export", () => {
    const parsed = parseVaultCsv(
      "name,url,username,password,note\nGitHub,https://github.com/login,octo,pw1,work\n",
    );
    expect(parsed.format).toBe("Chrome or Edge");
    expect(parsed.items).toEqual([
      {
        kind: "login",
        title: "GitHub",
        websites: ["https://github.com/login"],
        username: "octo",
        password: "pw1",
        hints: "work",
      },
    ]);
  });

  it("reads Safari, Firefox and 1Password exports", () => {
    expect(
      parseVaultCsv("Title,URL,Username,Password,Notes,OTPAuth\nApple,https://apple.com,a,p,,\n")
        .format,
    ).toBe("Safari or Apple Passwords");
    const firefox = parseVaultCsv(
      "url,username,password,httpRealm,formActionOrigin,guid,timeCreated,timeLastUsed,timePasswordChanged\nhttps://mozilla.org,m,p,,,{1},1,1,1\n",
    );
    expect(firefox.format).toBe("Firefox");
    expect(firefox.items[0]).toMatchObject({ title: "mozilla.org", username: "m" });
    expect(
      parseVaultCsv(
        "Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes\nX,x.com,u,p,,,,,\n",
      ).format,
    ).toBe("1Password");
  });

  it("skips Bitwarden notes and LastPass secure notes", () => {
    const bitwarden = parseVaultCsv(
      "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n,,login,Site,,,,https://a.com https://b.com,u,p,\n,,note,Secret note,text,,,,,,\n",
    );
    expect(bitwarden.format).toBe("Bitwarden");
    expect(bitwarden.items).toMatchObject([{ websites: ["https://a.com", "https://b.com"] }]);
    expect(bitwarden.skipped).toBe(1);

    const lastpass = parseVaultCsv(
      "url,username,password,totp,extra,name,grouping,fav\nhttps://a.com,u,p,,,A,,0\nhttp://sn,,,,secret,Note,,0\n",
    );
    expect(lastpass.format).toBe("LastPass");
    expect(lastpass.items).toHaveLength(1);
    expect(lastpass.skipped).toBe(1);
  });

  it("skips rows with neither a username nor a password", () => {
    const parsed = parseVaultCsv("name,url,username,password\nEmpty,https://a.com,,\n");
    expect(parsed).toEqual({ format: "Chrome or Edge", items: [], skipped: 1 });
  });

  it("reads contact info", () => {
    const parsed = parseVaultCsv(
      "label,name,email,phone,street,apt,city,state,zip,country\nHome,Ada,ada@example.com,555,1 Main St,,Springfield,IL,62701,US\n",
    );
    expect(parsed.format).toBe("Contact info");
    expect(parsed.items).toEqual([
      {
        kind: "contact",
        label: "Home",
        name: "Ada",
        emails: ["ada@example.com"],
        phones: ["555"],
        street: "1 Main St",
        apt: "",
        city: "Springfield",
        state: "IL",
        zip: "62701",
        country: "US",
      },
    ]);
  });
});
