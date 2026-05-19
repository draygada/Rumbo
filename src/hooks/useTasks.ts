import { useQuery } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { Task } from '../types'

export function useTasks() {
  return useQuery({
    queryKey: ['tasks'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('tasks')
        .select('*')
        .order('due_date', { ascending: true })
      if (error) throw error
      return data as Task[]
    },
  })
}
