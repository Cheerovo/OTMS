#!/usr/bin/env python3
"""
把 merge_attendance.py 输出的 CSV 转成 OTMS 可导入的 JSON

用法:
  python3 convert_attendance.py ~/Desktop/考勤数据

输出:
  在 CSV 同目录下生成 attendance_import.json
"""

import csv, json, os, sys, re

# 名字别名映射：繁体/英文 → 花名册标准名（统一匹配到同一个员工ID）
NAME_ALIASES = {
    '賴淑賢': '赖淑贤',
    'yvonne lai': '赖淑贤',
    'Yvonne Lai': '赖淑贤',
    'YVONNE LAI': '赖淑贤',
}

def normalize_name(name):
    """将别名统一为标准名"""
    n = name.strip()
    return NAME_ALIASES.get(n, n)

def main():
    folder = sys.argv[1] if len(sys.argv) > 1 else '.'
    detail_csv = os.path.join(folder, '考勤明细_打卡记录.csv')
    summary_csv = os.path.join(folder, '考勤明细_月度汇总.csv')

    if not os.path.exists(detail_csv):
        print(f"找不到: {detail_csv}")
        sys.exit(1)
    if not os.path.exists(summary_csv):
        print(f"找不到: {summary_csv}")
        sys.exit(1)

    # ---- Parse detail records ----
    detail_by_date = {}  # {date: {name: {ci, cir, co, cor, sc, ap, src}}}
    with open(detail_csv, 'r', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        for row in reader:
            name = normalize_name(row.get('姓名', '').strip())
            date = row.get('日期', '').strip()
            if not name or not date:
                continue
            if name in ('员工姓名', '合计', '总计'):
                continue

            ci = row.get('上班打卡', '').strip()
            cir = row.get('上班结果', '').strip()
            co = row.get('下班打卡', '').strip()
            cor = row.get('下班结果', '').strip()
            sc = row.get('班次', '').strip()
            ap = row.get('审批备注', '').strip()
            src = row.get('来源文件', '').strip()

            # Normalize: empty result with a time → "正常"
            if ci and not cir:
                cir = '正常'
            if co and not cor:
                cor = '正常'
            # Normalize: no data → skip entirely
            if not ci and not co and not cir and not cor:
                continue

            if date not in detail_by_date:
                detail_by_date[date] = {}
            detail_by_date[date][name] = {
                'ci': ci,
                'cir': cir,
                'co': co,
                'cor': cor,
                'sc': sc,
                'ap': ap,
                'src': src
            }

    # ---- Parse summary records ----
    summary_by_month = {}  # {month: {name: {a,l,s,p,lt,ms,ot,ab,n}}}
    with open(summary_csv, 'r', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        for row in reader:
            name = normalize_name(row.get('姓名', '').strip())
            month_val = row.get('统计月份', '').strip()
            if not name or not month_val:
                continue
            if name in ('员工姓名', '合计', '总计'):
                continue

            # 2026-07-01 → 2026-07
            month = month_val[:7] if len(month_val) >= 7 else month_val

            late = _parse_int(row.get('迟到次数', ''))
            miss = _parse_int(row.get('缺卡次数', ''))
            ot = _parse_float(row.get('加班小时', ''))
            annual = _parse_float(row.get('年假天数', ''))
            lieu = _parse_float(row.get('调休天数', ''))
            sick = _parse_float(row.get('病假天数', ''))
            personal = _parse_float(row.get('事假天数', ''))
            abnormal = _parse_int(row.get('考勤异常天数', ''))
            note = row.get('备注', '').strip()

            if month not in summary_by_month:
                summary_by_month[month] = {}

            summary_by_month[month][name] = {
                'a': annual,
                'l': lieu,
                's': sick,
                'p': personal,
                'lt': late,
                'ms': miss,
                'ot': ot,
                'ab': abnormal,
                'n': note
            }

    # ---- Output ----
    output = {
        'detail': detail_by_date,
        'summary': summary_by_month
    }

    out_path = os.path.join(folder, 'attendance_import.json')
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    detail_dates = len(detail_by_date)
    detail_entries = sum(len(v) for v in detail_by_date.values())
    summary_months = len(summary_by_month)
    summary_entries = sum(len(v) for v in summary_by_month.values())

    print(f"生成: {out_path}")
    print(f"  打卡记录: {detail_entries} 条, {detail_dates} 天")
    print(f"  月度汇总: {summary_entries} 条, {summary_months} 个月")


def _parse_int(s):
    try:
        return int(float(str(s).strip()))
    except (ValueError, TypeError):
        return 0


def _parse_float(s):
    try:
        return float(str(s).strip())
    except (ValueError, TypeError):
        return 0.0


if __name__ == '__main__':
    main()
