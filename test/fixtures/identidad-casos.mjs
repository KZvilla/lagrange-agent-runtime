// FEAT-123 — Casos que corren las dos copias de la regla: mcp-server/lib/identidad-sesion.js (test/identidad-sesion.test.js) y hooks/identidad.ts (test/identidad-mod.test.tsx). Si una diverge, falla su suite.
// (.mjs: el kit de `claude plugin test` no importa JSON.)
export default {
  "home": "C:\\Users\\X",
  "cuentas": {
    "trabajo": {
      "configDir": "~/.claude-work"
    },
    "lab": {
      "configDir": "D:/cuentas/lab/"
    }
  },
  "resolver": [
    {
      "configDir": "",
      "cuenta": "principal"
    },
    {
      "configDir": "   ",
      "cuenta": "principal"
    },
    {
      "configDir": null,
      "cuenta": "principal"
    },
    {
      "configDir": "C:\\Users\\X\\.claude",
      "cuenta": "principal"
    },
    {
      "configDir": "c:/users/x/.claude/",
      "cuenta": "principal"
    },
    {
      "configDir": "~/.claude",
      "cuenta": "principal"
    },
    {
      "configDir": "C:\\Users\\X\\.claude-work",
      "cuenta": "trabajo"
    },
    {
      "configDir": "C:/USERS/x/.Claude-Work\\",
      "cuenta": "trabajo"
    },
    {
      "configDir": "~/.claude-work",
      "cuenta": "trabajo"
    },
    {
      "configDir": "d:\\cuentas\\lab",
      "cuenta": "lab"
    },
    {
      "configDir": "C:\\Users\\X\\.claude-otra",
      "cuenta": null
    },
    {
      "configDir": "C:\\Users\\X\\.claude-work\\sub",
      "cuenta": null
    }
  ],
  "resolverSinCuentas": [
    {
      "configDir": "",
      "cuenta": "principal"
    },
    {
      "configDir": "C:\\Users\\X\\.claude-work",
      "cuenta": null
    }
  ],
  "validar": [
    {
      "crudo": {
        "nombre": "Spica",
        "emblema": "✦",
        "color": "cian"
      },
      "identidad": {
        "nombre": "Spica",
        "emblema": "✦",
        "color": "cian"
      }
    },
    {
      "crudo": {
        "nombre": "  Epikouros  ",
        "emblema": "☘️"
      },
      "identidad": {
        "nombre": "Epikouros",
        "emblema": "☘️",
        "color": null
      }
    },
    {
      "crudo": {
        "nombre": "Spica",
        "color": 208
      },
      "identidad": {
        "nombre": "Spica",
        "emblema": null,
        "color": 208
      }
    },
    {
      "crudo": {
        "nombre": "Spica",
        "color": "fucsia"
      },
      "identidad": {
        "nombre": "Spica",
        "emblema": null,
        "color": "fucsia"
      }
    },
    {
      "crudo": {
        "nombre": "Spica",
        "emblema": "abc"
      },
      "identidad": {
        "nombre": "Spica",
        "emblema": null,
        "color": null
      }
    },
    {
      "crudo": {
        "nombre": "Spica",
        "emblema": "✦✦"
      },
      "identidad": {
        "nombre": "Spica",
        "emblema": "✦✦",
        "color": null
      }
    },
    {
      "crudo": {
        "nombre": "Spica",
        "emblema": "\u001b[31m"
      },
      "identidad": {
        "nombre": "Spica",
        "emblema": null,
        "color": null
      }
    },
    {
      "crudo": {
        "nombre": "Spica",
        "emblema": "  "
      },
      "identidad": {
        "nombre": "Spica",
        "emblema": null,
        "color": null
      }
    },
    {
      "crudo": {
        "nombre": "Spica",
        "color": true
      },
      "identidad": {
        "nombre": "Spica",
        "emblema": null,
        "color": null
      }
    },
    {
      "crudo": {
        "nombre": "    "
      },
      "identidad": null
    },
    {
      "crudo": {
        "nombre": ""
      },
      "identidad": null
    },
    {
      "crudo": {
        "nombre": "abcdefghijklmnopqrstuvwxy"
      },
      "identidad": null
    },
    {
      "crudo": {
        "nombre": "abcdefghijklmnopqrstuvwx"
      },
      "identidad": {
        "nombre": "abcdefghijklmnopqrstuvwx",
        "emblema": null,
        "color": null
      }
    },
    {
      "crudo": {
        "nombre": "Spi\nca"
      },
      "identidad": null
    },
    {
      "crudo": {
        "nombre": 7
      },
      "identidad": null
    },
    {
      "crudo": "Spica",
      "identidad": null
    },
    {
      "crudo": null,
      "identidad": null
    }
  ],
  "deConfig": [
    {
      "config": {
        "identidad_sesion": {
          "principal": {
            "nombre": "Spica"
          }
        }
      },
      "configDir": "",
      "identidad": {
        "nombre": "Spica",
        "emblema": null,
        "color": null
      }
    },
    {
      "config": {
        "identidad_sesion": {
          "principal": {
            "nombre": "Spica"
          },
          "trabajo": {
            "nombre": "Epikouros"
          }
        },
        "motores": {
          "cuentas": {
            "trabajo": {
              "configDir": "~/.claude-work"
            }
          }
        }
      },
      "configDir": "C:\\Users\\X\\.claude-work",
      "identidad": {
        "nombre": "Epikouros",
        "emblema": null,
        "color": null
      }
    },
    {
      "config": {
        "identidad_sesion": {
          "principal": {
            "nombre": "Spica"
          }
        }
      },
      "configDir": "C:\\Users\\X\\.claude-work",
      "identidad": null
    },
    {
      "config": {
        "identidad_sesion": {
          "trabajo": {
            "nombre": "Epikouros"
          }
        }
      },
      "configDir": "",
      "identidad": null
    },
    {
      "config": {
        "identidad_sesion": {
          "principal": {
            "nombre": "  "
          }
        }
      },
      "configDir": "",
      "identidad": null
    },
    {
      "config": {
        "identidad_sesion": [
          "no",
          "objeto"
        ]
      },
      "configDir": "",
      "identidad": null
    },
    {
      "config": {
        "motores": 3,
        "identidad_sesion": {
          "principal": {
            "nombre": "Spica"
          }
        }
      },
      "configDir": "",
      "identidad": {
        "nombre": "Spica",
        "emblema": null,
        "color": null
      }
    },
    {
      "config": {},
      "configDir": "",
      "identidad": null
    },
    {
      "config": null,
      "configDir": "",
      "identidad": null
    }
  ]
}
