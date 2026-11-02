import sys, ast, json
raw = sys.stdin.read().strip()
t = raw[raw.index("'"):raw.rindex("'") + 1]
d = json.loads(json.loads(ast.literal_eval(t)))
print(json.dumps(d.get(sys.argv[1])))
