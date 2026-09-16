---
title: "算法学习笔记：二分查找"
slug: "algorithm-notes"
summary: "二分查找的核心思想、边界条件与常见陷阱。"
status: "public"
publishedAt: "2025-07-02T14:30:00.000Z"
tags: ["算法", "计算机基础"]
category: "技术"
pinned: false
---

# 二分查找笔记

二分查找适用于**有序数组**，核心是不断缩小搜索区间。

## 基本模板

```python
def binary_search(nums, target):
    left, right = 0, len(nums) - 1
    while left <= right:
        mid = (left + right) // 2
        if nums[mid] == target:
            return mid
        elif nums[mid] < target:
            left = mid + 1
        else:
            right = mid - 1
    return -1
```

## 常见陷阱

边界条件写错是最常见的二分查找 bug，注意循环不变量。
